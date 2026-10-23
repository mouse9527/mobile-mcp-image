"""Lease gateway smoke (PHONE_LEASE=1), no phone needed. Talks to the gateway the way an MCP gateway such as LiteLLM does:
a new MCP session for every tool call, identity in forwarded headers (x-phone-holder / x-openwebui-chat-id, or the
client's session id as mcp-session-id, which stays on every request because mobile-mcp is stateless). Uses mobile_list_available_devices as the "phone" call.
Expects the container started with LEASE_IDLE_S=3 LEASE_WAIT_S=2 LEASE_TICKET_S=4 LEASE_GRACE_S=3
LEASE_SESSION_FIRST_IDLE_S=1 LEASE_HOLD_MAX_S=8.   usage: lease_test.py <url>"""
import json, sys, threading, time, urllib.request

URL = sys.argv[1]
BUSY = '手机正在被另一个任务使用'
RES = []


def check(name, ok, detail=''):
    RES.append(bool(ok))
    print(('ok: ' if ok else 'FAIL: ') + name + (f'  [{detail}]' if detail else ''), flush=True)


def post(body, headers):
    r = urllib.request.Request(URL, data=json.dumps(body).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', **headers})
    with urllib.request.urlopen(r, timeout=60) as f:
        raw, sid = f.read().decode(), f.headers.get('Mcp-Session-Id')
    for line in raw.splitlines():
        if line.startswith('data:'):
            return json.loads(line[5:]), sid
    return (json.loads(raw) if raw.strip() else {}), sid


def rpc(method, params, holder=None, chat=None, client_session=None):
    """one upstream session: initialize (+ forwarded client session id) -> method -> DELETE"""
    ident = {**({'x-phone-holder': holder} if holder else {}), **({'X-OpenWebUI-Chat-Id': chat} if chat else {})}
    _, sid = post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18',
                   'capabilities': {}, 'clientInfo': {'name': 'lease-smoke', 'version': '0'}}},
                  {**ident, **({'mcp-session-id': client_session} if client_session else {})})
    # stateless mobile-mcp issues no session id; LiteLLM then keeps the forwarded client session id on every request
    h = {**ident, **({'mcp-session-id': sid or client_session} if (sid or client_session) else {})}
    post({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, h)
    m, _ = post({'jsonrpc': '2.0', 'id': 2, 'method': method, 'params': params}, h)
    if sid:
        urllib.request.urlopen(urllib.request.Request(URL, method='DELETE', headers={'mcp-session-id': sid}), timeout=10).close()
    return m


def call(tool='mobile_list_available_devices', args=None, **who):
    """-> (got the phone, text, seconds)"""
    t = time.time()
    r = rpc('tools/call', {'name': tool, 'arguments': args or {}}, **who).get('result') or {}
    txt = ''.join(c.get('text', '') for c in r.get('content', []))
    return BUSY not in txt, txt, time.time() - t


def bg(fn, *a, **k):
    out = {}
    th = threading.Thread(target=lambda: out.setdefault('r', fn(*a, **k)))
    th.start()
    return th, out


def settle():
    time.sleep(3.5)  # > idle: previous leases gone


tools = rpc('tools/list', {})['result']['tools']
names = [t['name'] for t in tools]
check('tools/list = 33 mobile-mcp tools + lease_status / lease_hold / lease_release',
      len(names) == 36 and names[-3:] == ['lease_status', 'lease_hold', 'lease_release'], str(len(names)))
check('tokens off: no lease_acquire, no extra `lease` argument on phone tools',
      'lease_acquire' not in names and not any('lease' in (t.get('inputSchema') or {}).get('properties', {}) for t in tools[:33]))

# header holders: A keeps working, B waits WAIT then gets busy with its position; A releases -> B right away
call(holder='A')
th, out = bg(call, holder='B')
for _ in range(3):
    time.sleep(0.6)
    call(holder='A')
th.join()
okB, txtB, sB = out['r']
check('busy: another holder waits ~2 s, then a busy error with its position', not okB and '第 1 位' in txtB and 1.8 < sB < 3.5, f'{sB:.1f}s')
th, out = bg(call, holder='B')
time.sleep(0.3)
call('lease_release', holder='A')
th.join()
check('lease_release hands the phone to the waiting holder at once', out['r'][0] and out['r'][2] < 1.5, f"{out['r'][2]:.1f}s")
call('lease_release', holder='B')

# FIFO
call(holder='A')
thB, oB = bg(call, holder='B')
time.sleep(0.2)
thC, oC = bg(call, holder='C')
time.sleep(0.2)
st = call('lease_status', holder='C')[1]
call('lease_release', holder='A')
thB.join()
call('lease_release', holder='B')
thC.join()
check('FIFO: C waits behind B (status says position 2), gets the phone after B', '第 2 位' in st and oB['r'][0] and oC['r'][0])
call('lease_release', holder='C')

# OWUI chat id: the same chat across two turns (two sessions) is one holder; another chat is someone else
call(chat='chat-1')
same, _, _ = call(chat='chat-1')
other, _, _ = call(chat='chat-2')
check('chat id: same chat = same holder, another chat is refused', same and not other)
call('lease_release', chat='chat-1')

# client session id (forwarded on initialize only): same client session = same holder; a new one = someone else
settle()
call(client_session='cs-1')
call(client_session='cs-1')  # second call: past the first-call probation
s1, _, _ = call(client_session='cs-1')
s2, _, _ = call(client_session='cs-2')
st1 = call('lease_status', client_session='cs-1')[1]
check('client session: same id = same holder, another id refused; lease_status says via session',
      s1 and not s2 and '你持有手机' in st1, st1[:20])
call('lease_release', client_session='cs-1')

# probation: a caller that opens a new client session per call is not stuck behind its own last call
settle()
call(client_session='once-1')
okp, _, sp = call(client_session='once-2')
check('first-call probation (1 s): next call from a new session gets the phone, not refused', okp, f'{sp:.1f}s')

# anon (nothing forwarded): runs alone but never keeps the phone
settle()
call(holder='H')
call(holder='H')
oka, _, _ = call()
check('anon waits behind a holder and is refused while it works', not oka)
call('lease_release', holder='H')
call()
okh, _, sh = call(holder='H')
check('anon does not keep the phone: a holder gets it right after', okh and sh < 1.0, f'{sh:.1f}s')
call('lease_release', holder='H')

# hold: capped, keeps the phone past idle, non-holders cannot hold
call(holder='A')
hold_ok, hold_txt, _ = call('lease_hold', {'seconds': 100}, holder='A')
time.sleep(3.5)
okB, _, _ = call(holder='B')
nh, _, _ = call('lease_hold', {'seconds': 10}, holder='B')
check('lease_hold: capped to 8 s, keeps the phone past idle, a non-holder cannot hold',
      hold_ok and '8 秒' in hold_txt and not okB and not nh)
call('lease_release', holder='A')

print('lease smoke %d/%d' % (sum(RES), len(RES)))
sys.exit(0 if all(RES) else 1)
