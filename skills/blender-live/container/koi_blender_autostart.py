# container/koi_blender_autostart.py — the Blender analogue of freecad-live's
# Mod/koi_bridge/InitGui.py, and the only file this skill puts inside the
# container.
#
# It is copied to
#   /config/.config/blender/<ver>/scripts/startup/koi_blender_autostart.py
# which is on the bind mount, so it gets in — and gets fixed — without
# rebuilding the image. Blender imports every .py under scripts/startup/ during
# startup, before any .blend is loaded.
#
# Two jobs upstream's addon cannot do for itself in a container:
#
#   1. Enable itself. The image ships a clean /config, addon_enable is a
#      preferences write, and nobody is sitting in front of the GUI on first
#      boot to tick the checkbox. Without this the human opens the stream tab
#      and finds no MCP panel, which reads like a broken image rather than an
#      unticked box.
#
#   2. Bind somewhere reachable. BlenderMCPServer.__init__ defaults to
#      host='localhost' and BLENDERMCP_OT_StartServer passes only `port`, so
#      there is no path through the UI to any other interface. That is exactly
#      right for the default deployment — the MCP server is spawned inside this
#      same netns with `podman exec`, so the socket must NOT leave it — and it
#      is exactly wrong for the remote variant, where 9876 is published into an
#      SSH tunnel and a process on the container's loopback is unreachable
#      through -p. KOI_BLENDER_HOST is the one knob, and it defaults to the
#      safe answer.
#
# Deliberately not here: anything about asset providers. They default off in
# upstream's own properties and that is the human's checkbox, not ours.
#
# Shape: register()/unregister(), not module-level code. bpy.utils.load_scripts
# imports every module under scripts/startup and then calls register() on it —
# module-level code does run, but a module without register() earns a warning
# on every launch ("this is now a requirement for registerable scripts") and is
# excluded from Reload Scripts, so an edit here would need a full restart to
# take. Following the contract costs four lines.

import os
import traceback

import bpy
import addon_utils

HOST = os.environ.get("KOI_BLENDER_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOI_BLENDER_PORT", "9876"))
# Upstream's installer has used more than one filename for this. Rather than
# pin a guess, take an override and otherwise recognise the module by shape.
WANTED = os.environ.get("KOI_BLENDER_ADDON", "")
DELAY = float(os.environ.get("KOI_BLENDER_DELAY", "3.0"))
# Retry rather than give up once: on a cold /config the addon directory can be
# mid-write when this first fires, and a single miss looks identical to a
# permanently broken install.
ATTEMPTS = int(os.environ.get("KOI_BLENDER_ATTEMPTS", "10"))
RETRY_EVERY = float(os.environ.get("KOI_BLENDER_RETRY_EVERY", "2.0"))
LOG = os.environ.get("KOI_BLENDER_LOG", "/config/koi-autostart.log")

_attempt = 0


def _log(msg):
    # Two destinations, because neither is reliable alone. stdout is
    # `podman logs`, which is the obvious place to look and is broken outright
    # on hosts where podman defaults to the journald driver and journald is not
    # really there — WSL2, most of the time. The file is on the bind mount, so
    # it survives the container and can be read with `cat` from the host even
    # when the container will not start.
    line = "koi_blender_autostart: %s" % msg
    # flush: Blender's stdout is a pipe to the container's logger, so without
    # this the interesting lines sit in a buffer until the process exits —
    # which, for a GUI session, is never.
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except Exception:
        pass  # a log that cannot be written must not take Blender down


def _same_host(a, b):
    # 'localhost' and '127.0.0.1' are the same socket, and the addon hardcodes
    # the former while this script defaults to the latter. Comparing the
    # strings made every launch look like a host change, which is how a working
    # server got torn down and replaced for no reason at all.
    loopback = {"localhost", "127.0.0.1", "::1", ""}
    if a in loopback and b in loopback:
        return True
    return a == b


def _candidates():
    if WANTED:
        return [WANTED]
    names = []
    for mod in addon_utils.modules(refresh=True):
        name = getattr(mod, "__name__", "")
        info = getattr(mod, "bl_info", {}) or {}
        label = "%s %s" % (name, info.get("name", ""))
        if "mcp" in label.lower() and "blender" in label.lower():
            names.append(name)
    # Deterministic order so two installed copies do not alternate between boots.
    return sorted(set(names))


def _start():
    global _attempt
    _attempt += 1
    try:
        return _start_inner()
    except Exception:
        # A timer callback that raises is unregistered by Blender and the
        # traceback goes to a console nobody is attached to. Catch it here so
        # the reason ends up somewhere a human will actually find it.
        _log("attempt %d raised:\n%s" % (_attempt, traceback.format_exc()))
        return _retry()


def _retry():
    if _attempt >= ATTEMPTS:
        _log("giving up after %d attempts" % _attempt)
        return None
    return RETRY_EVERY


def _start_inner():
    _log(
        "attempt %d: blender %s, scripts %s"
        % (_attempt, bpy.app.version_string, bpy.utils.user_resource("SCRIPTS"))
    )
    names = _candidates()
    if not names:
        _log(
            "no MCP addon found under scripts/addons. Run the container setup "
            "script again; it installs the addon into /config."
        )
        return _retry()

    module = None
    for name in names:
        try:
            mods = addon_utils.enable(name, default_set=True, persistent=True)
        except Exception as exc:  # a broken addon must not take Blender down
            _log("enable(%s) failed: %s" % (name, exc))
            continue
        if mods is not None and hasattr(mods, "BlenderMCPServer"):
            module = mods
            break

    if module is None:
        _log("enabled %s but none of them exposes BlenderMCPServer" % ", ".join(names))
        return _retry()

    # enable() runs the addon's register(), which auto-starts a server of its
    # own (blendermcp_auto_start_server defaults to True) on 'localhost'. In the
    # default deployment that IS what we want, so adopt it and touch nothing.
    server = getattr(bpy.types, "blendermcp_server", None)
    if server is not None and getattr(server, "running", False):
        if getattr(server, "port", None) == PORT \
                and _same_host(getattr(server, "host", ""), HOST):
            _log(
                "adopting the addon's own server on %s:%s"
                % (getattr(server, "host", "?"), getattr(server, "port", "?"))
            )
            return None
        # Genuinely wrong endpoint — only reachable with --publish-mcp, where we
        # need 0.0.0.0 and the addon gave us loopback. Stop it and come back on
        # the next tick rather than rebinding in the same breath: stop() returns
        # before the accept thread has let go of the socket, so an immediate
        # bind fails with EADDRINUSE and leaves nothing listening at all.
        _log(
            "replacing the addon's server on %s:%s with %s:%d"
            % (getattr(server, "host", "?"), getattr(server, "port", "?"), HOST, PORT)
        )
        try:
            server.stop()
        except Exception as exc:
            _log("could not stop the existing server: %s" % exc)
        return _retry()

    fresh = module.BlenderMCPServer(host=HOST, port=PORT)
    fresh.start()

    # start() swallows its own failures: it prints "Failed to start server: ..."
    # (no "BlenderMCP" prefix, so a grep for that misses it), calls stop(), and
    # returns normally. Without this check the script logs "listening" over a
    # socket that does not exist, which is exactly the lie that cost us an
    # evening.
    if not getattr(fresh, "running", False):
        _log(
            "start() did not bind %s:%d — upstream printed the reason on stdout "
            "(podman logs koi-blender). Retrying." % (HOST, PORT)
        )
        return _retry()

    bpy.types.blendermcp_server = fresh

    # The N-panel reads this. Left stale, the panel says "not connected" over a
    # working socket and the human clicks Connect on a port that is already
    # bound, which fails in a way that looks like the addon is broken.
    scene = getattr(bpy.context, "scene", None)
    if scene is not None:
        try:
            scene.blendermcp_server_running = bpy.types.blendermcp_server.running
        except AttributeError:
            pass

    _log(
        "listening on %s:%d (addon %s)"
        % (HOST, PORT, getattr(module, "__name__", "?"))
    )
    return None  # unregister the timer


def register():
    # Same reasoning as freecad-live's QTimer.singleShot(4000, ...): at this
    # point the window manager does not exist yet, addon registration that
    # touches bpy.context.scene raises, and bpy.app.timers is the only
    # documented way to get a callback onto the main thread once startup has
    # settled. persistent=True so loading a .blend does not cancel it.
    _log("startup script registered; first attempt in %.1fs" % DELAY)
    if not bpy.app.timers.is_registered(_start):
        bpy.app.timers.register(_start, first_interval=DELAY, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_start):
        bpy.app.timers.unregister(_start)
    server = getattr(bpy.types, "blendermcp_server", None)
    if server is not None:
        try:
            server.stop()
        except Exception:
            pass