#!/usr/bin/env node
// Five assertions against ws://localhost:8080/mcp/blender:
//   1 transport      gateway ran `podman exec` and the MCP handshake works
//   2 blender socket  the server reaches the addon on the container's :9876
//   3 stdout capture  execute_blender_code returns what the snippet printed
//   4 image channel   an image content block survives the WS->stdio bridge
//   5 stream          the Selkies WebRTC desktop answers on host :3001
//
// 1-4 all run through the container's own network namespace, so they pass with
// nothing published to the host at all. 5 is the only one about the published
// surface, and it is last on purpose: a green 1-4 with a red 5 means the agent
// has a session the human cannot watch, which is a different bug from no
// session at all.
//
// 4 is a real assertion. get_viewport_screenshot was once XFAIL'd as "severs
// the socket"; the actual cause was the gateway dying on an EPIPE mid-frame
// (see guardrail.js). A red 4 now means the image channel is broken.
import WebSocket from 'ws';
import tls from 'node:tls';
const URL = process.env.KOI_GW || 'ws://localhost:8080/mcp/blender';
const STREAM_PORT = Number(process.env.KOI_STREAM_PORT || 3001);
const TOTAL = 5;
// Self-signed by design (LinuxServer ships its own cert), so this asks whether
// anything is listening and speaking TLS, not whether a CA vouches for it.
const streamUp = () => new Promise((r) => {
  const sock = tls.connect(
    { host: '127.0.0.1', port: STREAM_PORT, rejectUnauthorized: false, timeout: 3000 },
    () => { sock.end(); r(true); });
  sock.on('error', () => r(false));
  sock.on('timeout', () => { sock.destroy(); r(false); });
});
let n = 0, bad = 0; const pend = new Map();
const rpc = (method, params) => new Promise((r) => {
  const id = ++n; pend.set(id, r);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
const say = (i, ok, name, note) => {
  if (!ok) bad++;
  console.log(`${i}/${TOTAL} ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${note}`);
};
const bail = (m) => { console.error('FAIL  ' + m); process.exit(1); };
const ws = new WebSocket(URL);
const timer = setTimeout(() => bail('timed out after 60s'), 60000);
ws.on('error', (e) => bail(e.message));
ws.on('close', (c, r) => c !== 1000 && bail(`socket closed ${c} ${r}`));
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth' })));
ws.on('message', async (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.type !== 'ready') return;

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'koi-smoke', version: '1' } });
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  const tools = (await rpc('tools/list', {})).result?.tools || [];
  const names = tools.map((t) => t.name);
  say(1, names.includes('execute_blender_code'),
      'transport', `${names.length} tools registered`);
  // schema-driven: get_scene_info requires user_prompt, others do not
  const req = (t) => tools.find((x) => x.name === t)?.inputSchema?.required || [];
  const P = (t, a = {}) => req(t).includes('user_prompt')
    ? { ...a, user_prompt: 'koi smoke test' } : a;
  const call = (t, a) => rpc('tools/call', { name: t, arguments: P(t, a) });
  const txt = (r) => (r.result?.content || []).filter((c) => c.type === 'text')
    .map((c) => c.text).join('');

  // The gateway reuses the blender-mcp child across connections and that child
  // caches its socket to the addon, so the first call of a session can hit a
  // socket the addon already closed. Upstream reconnects on the next attempt.
  // Transient (retry): "connection closed before receiving a response".
  // Fatal (do not retry): "Errno 111" / "could not connect" = nothing listening.
  const TRANSIENT = /connection closed before receiving|communication error with blender/i;
  const callRetry = async (t, a) => {
    const r = await call(t, a);
    return TRANSIENT.test(txt(r)) ? call(t, a) : r;
  };

  const scene = await callRetry('get_scene_info');
  const st = txt(scene);
  const dead = /could not connect to blender|Errno 111|connection refused/i.test(st);
  let parsed = null; try { parsed = JSON.parse(st); } catch {}
  say(2, !!parsed && !dead, 'blender socket',
      parsed ? `scene "${parsed.name}", ${parsed.object_count} objects`
             : (dead ? 'addon not listening in the container — podman logs koi-blender'
                     : st.slice(0, 90)));

  // Wrapped exactly the way SKILL.md tells the model to wrap everything, and
  // for the same reason: bpy.app.build_hash is BYTES, json.dumps raises
  // TypeError on it, and upstream severs rather than returning the traceback.
  // An unwrapped probe here would have caught that on day one.
  const code = [
    'import bpy, json, traceback',
    'try:',
    '    bh = bpy.app.build_hash',
    '    print(json.dumps({"ok": True, "data": {',
    '        "v": bpy.app.version_string,',
    '        "build": bh.decode("utf-8", "replace") if isinstance(bh, bytes) else str(bh),',
    '        "n": len(bpy.data.objects)}}, default=str))',
    'except Exception:',
    '    print(json.dumps({"ok": False, "error": traceback.format_exc()[-500:]}))',
  ].join('\n');
  const ex = await callRetry('execute_blender_code', { code });
  const et = txt(ex); const s = et.indexOf('{');
  let env = null; try { env = JSON.parse(et.slice(s)); } catch {}
  say(3, !!env && env.ok === true, 'stdout capture',
      env?.ok ? `${env.data.v} build ${env.data.build}, ${env.data.n} objects`
              : (env ? 'snippet raised — ' + String(env.error).slice(0, 70)
                     : et.slice(0, 90)));

  const shot = await callRetry('get_viewport_screenshot', { max_size: 400 });
  const img = (shot.result?.content || []).find((c) => c.type === 'image');
  say(4, !!img, 'image channel',
      img ? `image block, ${img.data.length} b` : txt(shot).slice(0, 90));

  const up = await streamUp();
  say(5, up, 'stream', up ? `https://localhost:${STREAM_PORT} answers`
                          : `nothing on ${STREAM_PORT} — container down, or ports not published`);

  clearTimeout(timer); ws.close(1000);
  console.log(bad ? `\n${bad} of ${TOTAL} failed` : `\nAll ${TOTAL} passed — chain is live.`);
  process.exit(bad ? 1 : 0);
});
