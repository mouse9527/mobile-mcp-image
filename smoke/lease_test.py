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
check('tools/list = 33 mobile-mcp tools + phone_guide / lease_status / lease_hold / lease_release',
      len(names) == 37 and names[-4:] == ['phone_guide', 'lease_status', 'lease_hold', 'lease_release'], str(len(names)))
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

# a queued caller that stopped waiting does not get the phone parked for it when the hold ends (k8s#87 follow-up)
settle()
call('lease_hold', {'seconds': 6}, holder='H1')
okq, txtq, _ = call(holder='Q')            # waits 2 s, refused: Q has a place in the queue but no call waiting
call('lease_release', holder='H1')
okh2, _, sh2 = call('lease_hold', {'seconds': 5}, holder='H2')
check('hold ends, queued caller not waiting -> someone else can hold at once', not okq and '第 1 位' in txtq and okh2 and sh2 < 1.0,
      f'{sh2:.1f}s')
call('lease_release', holder='H2')
okc, _, sc = call(holder='H3')
check('… and call at once (no 30 s grace parked for the absent caller)', okc and sc < 1.0, f'{sc:.1f}s')
call('lease_release', holder='H3')

# A hold left by an earlier turn: a chat turn can be a new client session, so the new turn is "someone else" and can neither
# use nor release it. The release must not claim success, the busy text must say it is a hold, and `force` must end a HOLD
# (never someone who is simply working). Without `force` nothing changes.
settle()
call('lease_hold', {'seconds': 8}, client_session='turn-1')
okt2, txt_busy, _ = call(client_session='turn-2')
check('busy text says the holder is a lease_hold and how long it lasts', not okt2 and 'lease_hold' in txt_busy and '保留' in txt_busy, txt_busy[:60])
_, txt_rel, _ = call('lease_release', client_session='turn-2')
still, _, _ = call(client_session='turn-2')
check('release by a non-holder does not claim success and changes nothing',
      '已释放手机' not in txt_rel and '没有持有' in txt_rel and not still, txt_rel[:60])
_, txt_force, _ = call('lease_release', {'force': True}, client_session='turn-2')
okf, _, sf = call(client_session='turn-2')
check('release force=true ends someone else\'s hold at once', '强制' in txt_force and okf and sf < 1.0, f'{txt_force[:40]} {sf:.1f}s')
call('lease_release', client_session='turn-2')

settle()
call(holder='W')
call(holder='W')                                   # W is working, not holding
_, txt_nf, _ = call('lease_release', {'force': True}, holder='X')
okw, _, _ = call(holder='W')
okx, _, _ = call(holder='X')
check('force=true does not kick a holder that is just working (it expires by itself)',
      '不能强制' in txt_nf and okw and not okx, txt_nf[:60])
call('lease_release', holder='W')

# force-release while someone is waiting: the phone goes to the waiting caller at once, so the reply must not say "free"
settle()
call('lease_hold', {'seconds': 8}, holder='HF')
thw, ow = bg(call, holder='QW')               # waits in its call (up to 2 s)
time.sleep(0.3)
_, txt_fw, _ = call('lease_release', {'force': True}, holder='XF')
thw.join()
check('force-release with a caller waiting: it gets the phone, the reply says so and does not claim the phone is free',
      ow['r'][0] and '交给排队' in txt_fw and '空闲' not in txt_fw, txt_fw[:50])
call('lease_release', holder='QW')

settle()
_, txt_free, _ = call('lease_release', holder='Z')
check('release when the phone is free says so', '本来就是空闲' in txt_free, txt_free[:40])

# usage guide (M-332): phone_guide(topic?) and the core guide appended to a holder's first phone call
GUIDE = '手机使用说明（核心）'
gt = next(t for t in tools if t['name'] == 'phone_guide')
lh = next(t for t in tools if t['name'] == 'lease_hold')
check('lease_hold description and limit come from LEASE_HOLD_MAX_S (8 here), nothing hard-coded',
      '最多 8 秒' in lh['description'] and '1–8' in json.dumps(lh, ensure_ascii=False) and '600' not in json.dumps(lh))
tdesc = gt['inputSchema']['properties']['topic']['description']
check('phone_guide lists its topics', all(k in tdesc for k in ('captcha', 'input', 'screen', 'speed', 'app:taobao', 'app:dianping')), tdesc[:80])
settle()
core = call('phone_guide', holder='G0')[1]
check('phone_guide() = core guide with placeholders filled (idle 3 s, hold 8 s) and the topic index',
      GUIDE in core and '{{' not in core and '约 3 秒' in core and '最多 8 秒' in core and 'app:taobao' in core, core[:40])
okg, first, _ = call(holder='G1')
_, second, _ = call(holder='G1')
check('a holder\'s first phone call gets the core guide appended (not blocked); the next call does not',
      okg and GUIDE in first and GUIDE not in second, f'{len(first)} / {len(second)} chars')
call('lease_release', holder='G1')
call('phone_guide', holder='G2')
okr, after_read, _ = call(holder='G2')
check('a holder that read phone_guide() first gets no appendix', okr and GUIDE not in after_read)
t1 = call('phone_guide', {'topic': 'app:taobao'}, holder='G2')[1]
t2 = call('phone_guide', {'topic': '淘宝'}, holder='G2')[1]
t3 = call('phone_guide', {'topic': 'captcha'}, holder='G2')[1]
check('phone_guide(topic): app:<id>, an app name, a topic', t1.startswith('# 淘宝') and t2 == t1 and t3.startswith('# 验证码'))
bad = rpc('tools/call', {'name': 'phone_guide', 'arguments': {'topic': 'no-such-topic'}}, holder='G2').get('result') or {}
btxt = ''.join(c.get('text', '') for c in bad.get('content', []))
check('unknown topic: tool error listing the topics', bad.get('isError') is True and 'app:taobao' in btxt, btxt[:40])
# G2 holds the phone now: phone_guide neither waits for it nor takes it
okq, qtxt, sq = call('phone_guide', {'topic': 'input'}, holder='G3')
st3 = call('lease_status', holder='G3')[1]
check('phone_guide needs no lease: answers at once while another holder has the phone, takes nothing',
      okq and qtxt.startswith('# 输入文字') and sq < 1.0 and '你持有手机' not in st3, f'{sq:.1f}s')
call('lease_release', holder='G2')

print('lease smoke %d/%d' % (sum(RES), len(RES)))
sys.exit(0 if all(RES) else 1)
