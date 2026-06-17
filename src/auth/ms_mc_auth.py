import re
import requests
import warnings
import json
from urllib.parse import urlparse, parse_qs
import sys

warnings.filterwarnings("ignore")

SFTTAG_URL = (
    "https://login.live.com/oauth20_authorize.srf"
    "?client_id=00000000402B5328"
    "&redirect_uri=https://login.live.com/oauth20_desktop.srf"
    "&scope=service::user.auth.xboxlive.com::MBI_SSL"
    "&display=touch"
    "&response_type=token"
    "&locale=en"
)


def extract_server_data(html: str):
    match = re.search(r'var ServerData = ({.*?});', html, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except Exception:
        return None


def login(session: requests.Session, username: str, password: str):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    }

    r = session.get(SFTTAG_URL, headers=headers, timeout=15, verify=False)
    server_data = extract_server_data(r.text)
    if not server_data:
        return None

    sft_tag = server_data.get('sFTTag', '')
    ppft_match = re.search(r'value="([^"]+)"', sft_tag)
    if not ppft_match:
        return None

    urlpost = server_data.get('urlPost') or server_data.get('urlPostMsa')
    if not urlpost:
        return None

    login_data = {
        'login': username,
        'loginfmt': username,
        'passwd': password,
        'PPFT': ppft_match.group(1),
        'ps': '2',
        'type': '11',
        'LoginOptions': '3',
    }

    login_headers = headers.copy()
    login_headers['Content-Type'] = 'application/x-www-form-urlencoded'
    login_headers['Origin'] = 'https://login.live.com'
    login_headers['Referer'] = SFTTAG_URL

    response = session.post(
        urlpost,
        data=login_data,
        headers=login_headers,
        verify=False,
        timeout=15,
        allow_redirects=True,
    )

    if '#access_token' not in response.url:
        return None

    return parse_qs(urlparse(response.url).fragment).get('access_token', [None])[0]


def get_xbox_xsts(session: requests.Session, ms_token: str):
    r = session.post(
        'https://user.auth.xboxlive.com/user/authenticate',
        json={
            'Properties': {
                'AuthMethod': 'RPS',
                'SiteName': 'user.auth.xboxlive.com',
                'RpsTicket': ms_token,
            },
            'RelyingParty': 'http://auth.xboxlive.com',
            'TokenType': 'JWT',
        },
        timeout=15,
        verify=False,
    )
    if r.status_code != 200:
        return None
    data = r.json()
    xbox_token = data.get('Token')
    if not xbox_token:
        return None

    try:
        uhs = data['DisplayClaims']['xui'][0]['uhs']
    except Exception:
        return None

    r = session.post(
        'https://xsts.auth.xboxlive.com/xsts/authorize',
        json={
            'Properties': {'SandboxId': 'RETAIL', 'UserTokens': [xbox_token]},
            'RelyingParty': 'rp://api.minecraftservices.com/',
            'TokenType': 'JWT',
        },
        timeout=15,
        verify=False,
    )
    if r.status_code != 200:
        return None

    xsts = r.json().get('Token')
    if not xsts:
        return None
    return uhs, xsts


def get_mc_token(session: requests.Session, uhs: str, xsts: str):
    r = session.post(
        'https://api.minecraftservices.com/authentication/login_with_xbox',
        json={'identityToken': f'XBL3.0 x={uhs};{xsts}'},
        timeout=15,
        verify=False,
    )
    if r.status_code != 200:
        return None
    return r.json().get('access_token')


def get_mc_profile(session: requests.Session, access_token: str):
    r = session.get(
        'https://api.minecraftservices.com/minecraft/profile',
        headers={'Authorization': f'Bearer {access_token}'},
        timeout=15,
        verify=False,
    )
    if r.status_code != 200:
        return None

    p = r.json()
    return {'id': p.get('id'), 'name': p.get('name')}


def authenticate(username: str, password: str):
    session = requests.session()
    session.verify = False

    ms_token = login(session, username, password)
    if not ms_token:
        return None

    x = get_xbox_xsts(session, ms_token)
    if not x:
        return None
    uhs, xsts = x

    mc_token = get_mc_token(session, uhs, xsts)
    if not mc_token:
        return None

    profile = get_mc_profile(session, mc_token)
    if not profile:
        return None

    return {
        'token': mc_token,
        'profile': profile,
        'entitlements': {},
        'certificates': {},
    }


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(json.dumps({'error': 'Usage: python ms_mc_auth.py <username> <password>'}))
        sys.exit(1)

    result = authenticate(sys.argv[1], sys.argv[2])
    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({'error': 'Authentication failed'}))
        sys.exit(2)
