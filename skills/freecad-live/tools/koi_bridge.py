# koi_bridge.py — the FreeCAD half of freecad-live.
#
# Runs INSIDE a FreeCAD process and opens a loopback HTTP endpoint that
# mcp/freecad_mcp.js posts Python to. Three endpoints, no CAD knowledge at all:
# the bridge runs what it is given and marshals it onto the right thread.
#
#     GET  /hello   who is here: protocol, pid, GUI or headless, the FreeCAD
#                   this is inside, and a fingerprint of the binary on disk.
#     POST /exec    {"id","code","timeoutMs"} -> run it, return its payload.
#     GET  /file    ?path=  read back what an export wrote.
#
# ---------------------------------------------------------------------------
# Running it
#
#     freecad tools/koi_bridge.py        # GUI. This is the case that matters:
#                                        # the human sees the model and can
#                                        # take the mouse.
#     freecadcmd tools/koi_bridge.py     # headless. Geometry works; there is
#                                        # no human in the session.
#
# In the GUI it can also be installed as a macro (copy into the macro directory
# and run it from the Macro menu) or auto-started from FreeCAD's own
# InitGui/user init.
#
# It must run inside the FreeCAD the human is looking at. A second interpreter
# started next to it — `docker exec ... freecadcmd script.py` — has its own
# document in its own address space, and nothing built there ever appears on
# their screen. That is not a smaller version of co-design; it is a different
# program.
#
# ---------------------------------------------------------------------------
# The thread rule
#
# FreeCAD's Python is not thread-safe and the document belongs to the GUI
# thread. An HTTP server is threads by nature. So:
#
#   GUI      the server runs on a daemon thread and NEVER touches FreeCAD.
#            It puts the job on a queue; a QTimer created on the main thread
#            drains that queue and runs the job there. The request thread waits
#            on an Event.
#   headless there is no Qt event loop to marshal onto, so the server is
#            single-threaded and runs the job inline on the thread that is
#            already serving. Serial by construction, which is what is wanted.
#
# A QTimer polling a queue rather than QMetaObject.invokeMethod because timers
# cannot be started from a non-GUI thread and the invoke bindings differ
# between PySide2 and PySide6. The poll interval is the only latency this adds
# and it is milliseconds; the transport it replaces had a 250 ms floor.
#
# One job at a time, always. A second /exec while one is running gets 409 with
# what is running and for how long, rather than queueing behind it invisibly.
#
# ---------------------------------------------------------------------------
# Security — read this before changing the bind address
#
# This executes arbitrary Python with the user's privileges. It is exactly as
# dangerous as that sounds, and it is safe only because of three things
# together:
#
#   * It binds 127.0.0.1. Nothing off the machine can reach it. Do not change
#     this to 0.0.0.0 to "make Docker work" — publish the port instead, and
#     understand that you are then trusting everything that can reach the host.
#   * It sends no CORS headers. The extension reaches it through a background
#     fetch, which is not subject to CORS; a random web page attempting the
#     same POST is stopped by the browser before it arrives.
#   * A token, if you set one. This is the only defence against another process
#     or another user on the same machine, so set one on any host you share:
#
#         KOI_BRIDGE_TOKEN=$(openssl rand -hex 16) freecad tools/koi_bridge.py
#
#     and put the same value in `bridge-token:` in SKILL.md. Without it the
#     bridge starts anyway and says loudly that it did.
#
# Environment: KOI_BRIDGE_HOST, KOI_BRIDGE_PORT, KOI_BRIDGE_TOKEN,
# KOI_EXPORT_DIR (where koi_cad writes exports; also what /file is allowed to
# read from).

from __future__ import print_function

import json
import os
import queue
import sys
import tempfile
import threading
import time
import traceback

try:
    from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
except ImportError:  # pragma: no cover - FreeCAD ships py3, this is belt and braces
    raise SystemExit("koi_bridge requires Python 3")

try:
    from urllib.parse import urlparse, parse_qs, unquote
except ImportError:  # pragma: no cover
    raise SystemExit("koi_bridge requires Python 3")

import FreeCAD as App

try:
    import FreeCADGui as Gui
except Exception:
    Gui = None


# Must match BRIDGE_PROTOCOL in mcp/freecad_mcp.js. The two halves ship
# together; a mismatch is refused at attach rather than surfacing three calls
# later as a missing field.
PROTOCOL = 1

HOST = os.environ.get("KOI_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOI_BRIDGE_PORT", "8765"))
TOKEN = os.environ.get("KOI_BRIDGE_TOKEN") or None

# How often the GUI thread looks for work. 15 ms is under one frame at 60 Hz,
# so a call cannot visibly stutter the viewport, and it is well inside the
# noise of any real recompute.
PUMP_INTERVAL_MS = 15

STARTED = time.time()


def _export_dir():
    d = os.environ.get("KOI_EXPORT_DIR")
    return d if d else os.path.join(tempfile.gettempdir(), "koi_export")


def _export_status():
    """Can we actually write an export, checked by writing one.

    Reported at /hello rather than discovered at export time, because export
    time is the worst possible moment to find out: it is when somebody is
    handing work over, or checkpointing before a risky edit, and a permission
    error there arrives as a raw FreeCADError about creating directories.

    It matters most in exactly the deployment where it is most likely to fail.
    A bind-mounted host directory under rootless Podman belongs to a subuid
    that is not the container's PUID, so the mount is visible and unwritable —
    the one combination that looks fine until the moment it costs somebody a
    handover. Re-checked on every call rather than cached, so a chown on the
    host takes effect without restarting FreeCAD.
    """
    d = _export_dir()
    probe = os.path.join(d, ".koi_write_test")
    try:
        os.makedirs(d, exist_ok=True)
        with open(probe, "w") as fh:
            fh.write("koi")
        os.remove(probe)
        return {"dir": d, "writable": True, "error": None}
    except Exception as e:
        return {"dir": d, "writable": False, "error": "%s: %s" % (type(e).__name__, e)}


# ---------------------------------------------------------------------------
# Identity
#
# The same question mcp/freecad_mcp.js asks the interpreter, asked here so it
# has an answer even while the interpreter is busy. The layers have to be able
# to fail independently or they are one layer wearing three hats.


def _cfg(key):
    try:
        return App.ConfigGet(key) or ""
    except Exception:
        return ""


def _exe_path():
    """What launched this process. For display, not for the fingerprint."""
    p = os.environ.get("APPIMAGE")
    exe = sys.executable or ""
    if p and os.path.isfile(p):
        return p
    if exe and os.path.isfile(exe):
        return exe
    return p or exe or None


def _core_path():
    """The artifact whose bytes actually ARE the build.

    `sys.executable` is the obvious candidate and the wrong one. On the
    LinuxServer container image it is /opt/freecad/usr/bin/freecad — a 160 KB
    launcher that sets up paths and execs the real thing, and which can sit
    unchanged across an image rebuild that replaces every line of CAD code
    behind it. Fingerprinting it would give a pin that never trips, which is
    worse than no pin: it reports agreement it did not check.

    The extension module is the build. Prefer FreeCAD's own .so, fall back to
    Part's (it moves with every kernel change), and only then to the launcher —
    a fingerprint of the wrong file being better than none, provided the field
    says which file it measured.
    """
    for mod in (App, sys.modules.get("Part")):
        try:
            p = getattr(mod, "__file__", None)
            if p and os.path.isfile(p):
                return p
        except Exception:
            pass
    try:
        import Part

        p = getattr(Part, "__file__", None)
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass
    # AppImage: the mounted contents are a squashfs the host cannot stat
    # meaningfully, but the .AppImage file itself is exactly the artifact that
    # gets swapped.
    ai = os.environ.get("APPIMAGE")
    if ai and os.path.isfile(ai):
        return ai
    return _exe_path()


def _binary_fingerprint(path):
    """Size and mtime, not a hash.

    A hash of a 400 MB AppImage on every /hello is seconds of disk for a
    question asked once a session. Size plus mtime moves under every upgrade,
    reinstall and re-pull that could change behaviour, which is what the pin
    needs it to do. It also moves when nothing changed but the file was
    touched — a false alarm costs a re-probe, a missed change costs a wrong
    answer about the build, and those are not the same price.
    """
    if not path:
        return None, None, None
    try:
        st = os.stat(path)
    except Exception:
        return None, None, None
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))
    return "exe:%d@%d" % (st.st_size, int(st.st_mtime)), st.st_size, stamp


def _occ_version():
    try:
        import Part

        return str(getattr(Part, "OCC_VERSION", "")) or None
    except Exception:
        return None


def _gui_up():
    if Gui is None:
        return False
    try:
        return bool(Gui.getMainWindow())
    except Exception:
        return False


def identity():
    exe = _exe_path()
    core = _core_path()
    fp, size, stamp = _binary_fingerprint(core)
    version = _cfg("ExeVersion")
    suffix = _cfg("BuildVersionSuffix")
    if version and suffix and suffix not in version:
        version = version + suffix
    return {
        "app": {
            "version": version or None,
            "commit": _cfg("BuildRevisionHash") or None,
            "branch": _cfg("BuildRevisionBranch") or None,
            "buildDate": _cfg("BuildRevisionDate") or None,
            "occt": _occ_version(),
            "python": sys.version.split()[0],
            "exe": exe,
            # Named so a drift report can say what moved. A pin that trips on
            # "core" is a different build; one that trips on "exe" alone is a
            # repackaged launcher around the same one.
            "core": core,
            "resourceDir": _cfg("AppHomePath") or None,
        },
        "fingerprint": fp,
        "exeBytes": size,
        "exeModified": stamp,
    }


# ---------------------------------------------------------------------------
# The job pump


class Job(object):
    def __init__(self, job_id, code):
        self.id = job_id
        self.code = code
        self.done = threading.Event()
        self.payload = None
        self.error = None
        self.rc = 0
        self.queued_at = time.time()
        self.started_at = None
        self.finished_at = None

    def run(self):
        """Execute the snippet. Runs on the thread that owns the document."""
        self.started_at = time.time()
        ns = {"__name__": "__koi__"}
        try:
            exec(compile(self.code, "<koi>", "exec"), ns)
            self.payload = ns.get("_koi_s")
            if self.payload is None:
                # The wrapper always assigns it, so this is the wrapper being
                # wrong rather than the snippet failing — say which.
                self.error = "the snippet produced no _koi_s"
                self.rc = 1
        except BaseException as e:  # noqa: BLE001 - a bridge that dies is worse
            self.error = "%s: %s" % (type(e).__name__, e)
            self.rc = 1
            try:
                App.Console.PrintError("koi_bridge: %s\n" % traceback.format_exc())
            except Exception:
                pass
        finally:
            self.finished_at = time.time()
            self.done.set()


class Pump(object):
    """Owns the one-job-at-a-time rule and the thread it runs on."""

    def __init__(self):
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.current = None
        self.timer = None
        self.inline = False  # headless: run on the calling thread

    def running(self):
        j = self.current
        if j is None or j.done.is_set():
            return None
        return {
            "id": j.id,
            "since": time.strftime("%H:%M:%S", time.localtime(j.started_at or j.queued_at)),
            "elapsedMs": int((time.time() - (j.started_at or j.queued_at)) * 1000),
        }

    def submit(self, job, timeout_s):
        """Returns (accepted, job). Rejects rather than queueing."""
        with self.lock:
            busy = self.running()
            if busy:
                return False, busy
            self.current = job
        if self.inline:
            job.run()
        else:
            self.q.put(job)
        job.done.wait(timeout_s)
        return True, job

    def pump(self):
        """Called on the GUI thread by the timer. Drains one job per tick.

        One per tick, not the whole queue: only one job can be outstanding
        anyway, and a loop here would be a way to hold the GUI thread for
        longer than any single job asked for.
        """
        try:
            job = self.q.get_nowait()
        except queue.Empty:
            return
        job.run()

    def start_gui_timer(self):
        """Create the timer on the main thread. Qt requires it.

        FreeCAD ships a `PySide` alias for whichever real binding it was built
        against, but that shim has come and gone across versions and distro
        packages, so try the real names too rather than failing on a detail
        that has nothing to do with CAD.
        """
        QtCore = None
        for mod in ("PySide", "PySide6", "PySide2"):
            try:
                QtCore = __import__(mod + ".QtCore", fromlist=["QtCore"])
                break
            except Exception:
                continue
        if QtCore is None:
            raise RuntimeError("no PySide QtCore in this FreeCAD")

        self.timer = QtCore.QTimer()
        self.timer.setInterval(PUMP_INTERVAL_MS)
        self.timer.timeout.connect(self.pump)
        self.timer.start()
        return "qtimer/%dms" % PUMP_INTERVAL_MS


PUMP = Pump()


# ---------------------------------------------------------------------------
# HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "koi_bridge/%d" % PROTOCOL

    # BaseHTTPRequestHandler logs every request to stderr, which in the GUI
    # means FreeCAD's report view fills with noise the user did not ask for.
    def log_message(self, fmt, *a):
        pass

    # -- plumbing ----------------------------------------------------------

    def _send(self, code, obj, raw=None, content_type="application/json"):
        body = raw if raw is not None else json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # Deliberately no Access-Control-Allow-Origin: see the security note at
        # the top. The extension does not need it and a web page must not have
        # it.
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _authorised(self, params):
        if not TOKEN:
            return True
        sent = self.headers.get("X-Koi-Token")
        if not sent and params:
            vals = params.get("token")
            sent = vals[0] if vals else None
        return sent == TOKEN

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # -- routes ------------------------------------------------------------

    def do_GET(self):
        u = urlparse(self.path)
        params = parse_qs(u.query)
        if u.path == "/hello":
            return self._hello()
        if not self._authorised(params):
            return self._send(401, {"ok": False, "error": "bad or missing token"})
        if u.path == "/exec":
            # The POST fallback: same request, urlencoded. See bridgeFetch.
            payload = (params.get("payload") or [None])[0]
            try:
                data = json.loads(unquote(payload)) if payload else {}
            except Exception:
                return self._send(400, {"ok": False, "error": "payload was not JSON"})
            return self._exec(data)
        if u.path == "/file":
            return self._file((params.get("path") or [None])[0])
        return self._send(404, {"ok": False, "error": "no such endpoint"})

    def do_POST(self):
        u = urlparse(self.path)
        params = parse_qs(u.query)
        if not self._authorised(params):
            return self._send(401, {"ok": False, "error": "bad or missing token"})
        if u.path == "/exec":
            return self._exec(self._body())
        return self._send(404, {"ok": False, "error": "no such endpoint"})

    def _hello(self):
        out = {
            "ok": True,
            "protocol": PROTOCOL,
            "pid": os.getpid(),
            "gui": _gui_up(),
            "mode": "gui" if _gui_up() else "headless",
            "dispatch": DISPATCH,
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(STARTED)),
            "tokenRequired": bool(TOKEN),
            "running": PUMP.running(),
        }
        st = _export_status()
        out["exportDir"] = st["dir"]
        out["exportWritable"] = st["writable"]
        out["exportError"] = st["error"]
        out.update(identity())
        self._send(200, out)

    def _exec(self, data):
        code = data.get("code")
        if not isinstance(code, str) or not code.strip():
            return self._send(400, {"ok": False, "error": "code is required"})
        timeout_ms = int(data.get("timeoutMs") or 20000)
        job = Job(str(data.get("id") or ("job%d" % int(time.time() * 1000))), code)
        accepted, result = PUMP.submit(job, timeout_ms / 1000.0)
        if not accepted:
            # 409 rather than a queue: the caller is a turn in a conversation,
            # and a call that silently waited three minutes behind somebody
            # else's recompute is worse than a call that says what is going on.
            return self._send(
                409,
                {
                    "ok": False,
                    "busy": True,
                    "error": "another job is running on the FreeCAD thread",
                    "running": result,
                },
            )
        if not job.done.is_set():
            # Still running. Nothing here can interrupt work inside the geometry
            # kernel, and pretending otherwise would be the wasm wedge with
            # extra steps. Say so, keep the process, and let it finish.
            return self._send(
                504,
                {
                    "ok": False,
                    "busy": True,
                    "error": "the snippet outran its %dms budget and is still running" % timeout_ms,
                    "running": PUMP.running(),
                },
            )
        if job.error and job.payload is None:
            return self._send(200, {"ok": False, "error": job.error, "rc": job.rc})
        self._send(
            200,
            {
                "ok": True,
                "id": job.id,
                "rc": job.rc,
                "payload": job.payload,
                "ms": int(((job.finished_at or 0) - (job.started_at or 0)) * 1000),
            },
        )

    def _file(self, path):
        """Read back an export.

        Confined to the export directory: this endpoint exists so the user can
        pull a STEP into their downloads, not so anything that can reach the
        port can read ~/.ssh.
        """
        if not path:
            return self._send(400, {"ok": False, "error": "path is required"})
        root = os.path.realpath(_export_dir())
        full = os.path.realpath(path)
        if not (full == root or full.startswith(root + os.sep)):
            return self._send(
                403,
                {"ok": False, "error": "only files under %s can be read" % root},
            )
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except Exception as e:
            return self._send(404, {"ok": False, "error": str(e)})
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition",
            'attachment; filename="%s"' % os.path.basename(full).replace('"', ""),
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass


DISPATCH = "inline"


def _announce(msg, err=False):
    line = "koi_bridge: %s\n" % msg
    try:
        if err:
            App.Console.PrintError(line)
        else:
            App.Console.PrintMessage(line)
    except Exception:
        pass
    print(line, end="", file=sys.stderr if err else sys.stdout)


def _loopback(host):
    return host in ("127.0.0.1", "::1", "localhost")


def start():
    global DISPATCH

    # The default binding is loopback and the machine is the boundary. Inside a
    # container that is wrong twice over: a process bound to the container's
    # own 127.0.0.1 is not reachable through a published port at all, so the
    # deployment guide tells people to set KOI_BRIDGE_HOST=0.0.0.0 — correctly,
    # because there the boundary is the network namespace.
    #
    # The failure that follows is somebody copying that line onto a host with no
    # namespace around it and putting arbitrary Python execution on their LAN.
    # There is no warning wording strong enough to survive a copy-paste, so this
    # is a refusal instead.
    if not _loopback(HOST) and not TOKEN:
        _announce(
            "refusing to bind %s without a token. This endpoint runs Python as "
            "you, and off loopback the only thing protecting it is the token. "
            "Start with KOI_BRIDGE_TOKEN set:\n"
            "    KOI_BRIDGE_TOKEN=$(openssl rand -hex 16) freecad tools/koi_bridge.py\n"
            "and put the same value in bridge-token: in SKILL.md. If you meant "
            "to listen locally, leave KOI_BRIDGE_HOST unset." % HOST,
            err=True,
        )
        return None

    gui = _gui_up()
    if gui:
        # Server off the GUI thread, work marshalled back onto it.
        try:
            DISPATCH = PUMP.start_gui_timer()
        except Exception as e:
            _announce(
                "could not start the Qt pump (%s). Refusing to run: executing "
                "on the HTTP thread would corrupt the document." % e,
                err=True,
            )
            return None
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
        httpd.daemon_threads = True
        threading.Thread(target=httpd.serve_forever, daemon=True, name="koi_bridge").start()
    else:
        # No event loop to marshal onto. A single-threaded server runs jobs on
        # the thread that is already serving, which is the only thread there is.
        PUMP.inline = True
        DISPATCH = "inline"
        httpd = HTTPServer((HOST, PORT), Handler)

    ident = identity()
    _announce(
        "listening on http://%s:%d (protocol %d, %s, dispatch %s)"
        % (HOST, PORT, PROTOCOL, "gui" if gui else "headless", DISPATCH)
    )
    _announce(
        "FreeCAD %s @ %s, exports to %s"
        % (
            ident["app"]["version"] or "?",
            (ident["app"]["commit"] or "no commit hash")[:12],
            _export_dir(),
        )
    )
    st = _export_status()
    if not st["writable"]:
        _announce(
            "EXPORT DIRECTORY IS NOT WRITABLE: %s (%s). The session will build "
            "geometry fine and will not be able to hand any of it over. If this "
            "is a bind mount under rootless Podman, the container's user is a "
            "subuid and does not own it:\n"
            "    podman unshare chown -R 1000:1000 <host path>\n"
            "or point KOI_EXPORT_DIR somewhere the container already owns, such "
            "as /config/koi_export." % (st["dir"], st["error"]),
            err=True,
        )
    if TOKEN:
        _announce("token required (KOI_BRIDGE_TOKEN is set)")
    else:
        _announce(
            "NO TOKEN SET. Anything on this machine that can reach %s:%d can "
            "run Python as you. Fine for a single-user desktop; on a shared "
            "host set KOI_BRIDGE_TOKEN and put the same value in bridge-token: "
            "in SKILL.md." % (HOST, PORT),
            err=True,
        )

    if not gui:
        _announce("headless: serving in the foreground, Ctrl-C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            _announce("stopped")
    return httpd


SERVER = None

if SERVER is None:
    try:
        SERVER = start()
    except OSError as e:
        _announce(
            "could not bind %s:%d (%s). Another bridge is probably already "
            "running — check with: curl http://%s:%d/hello"
            % (HOST, PORT, e, HOST, PORT),
            err=True,
        )