/**
 * 리포트(공유될 수 있는 HTML·scenario.json)에 남기는 조작 문구에서 비밀값을 가린다.
 * 원칙: 값은 기본으로 가리고, 비밀이 아니라고 판단할 근거가 있을 때만 보여 준다.
 * (재실행용 스크립트 YAML 에는 값이 그대로 필요해 여기서 다루지 않는다)
 * 브라우저에서도 쓰므로 node 모듈을 가져오지 않는다.
 */

export const MASK = '●●●●';

/** 이름 어디에 있어도 비밀 칸으로 보는 긴 말 */
const SECRET_PART = /password|passwd|passcode|passphrase|secret|token|credential|session|cookie|bearer|private|비밀|암호|인증|카드|주민|계좌|휴대|전화/i;
/** 짧아서 다른 말 속에 섞이기 쉬운 것은 단어 단위로만 본다 (spinner·author·keyword 오판 방지) */
const SECRET_WORD = new Set(['pw', 'pwd', 'pin', 'otp', 'cvc', 'cvv', 'ssn', 'key', 'sig', 'auth', 'card', 'jwt', 'nonce', 'code', 'email', 'phone', 'tel', 'mobile', 'account', 'birth']);

/** 이름(키·리소스 id·힌트)이 비밀값·개인정보 칸을 뜻하는지 */
export function isSecretName(name: string | undefined): boolean {
  if (!name) return false;
  if (SECRET_PART.test(name)) return true;
  // auth_code · authCode · api-key → 단어로 나눠 본다
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => SECRET_WORD.has(w));
}

/** 값 모양이 토큰 같은지 (JWT, 긴 무공백 문자열, JSON) */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  return /^eyJ[\w-]+\./.test(v) || (v.length >= 24 && !/\s/.test(v)) || /^[{[]/.test(v);
}

/** 키-값 하나: 키가 비밀이거나 값이 토큰 같거나 길면 가린다 */
export function redactValue(key: string | undefined, value: string): string {
  if (isSecretName(key) || looksSecret(value) || value.length > 40) return `${MASK} (${value.length}자)`;
  return value;
}

/** URL 의 사용자 정보·쿼리 값·fragment, 토큰처럼 보이는 경로 조각을 가린다 (구조는 남긴다) */
export function redactUrl(uri: string): string {
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(uri);
  if (!m) return MASK;
  // scheme://사용자:비번@호스트 — 비밀번호에 @ 가 있어도 마지막 @ 까지 가린다
  const userless = m[1].replace(/^([a-z][\w+.-]*:\/\/)([^/]*@)/i, `$1${MASK}@`);
  // scheme://호스트 는 그대로 두고 그 뒤 경로만 본다
  const head = /^[a-z][\w+.-]*:\/\/[^/]*/i.exec(userless)?.[0] ?? '';
  // 경로 조각: 토큰 같은 값, 메일 주소(mailto:), 매트릭스 파라미터(;jsessionid=…)
  const path = userless.slice(head.length).replace(/([/:;])([^/:;]+)/g, (all, sep: string, seg: string) => {
    if (sep === ';') return `;${seg.includes('=') ? seg.slice(0, seg.indexOf('=') + 1) + MASK : MASK}`;
    return seg.includes('@') || looksSecret(seg) ? sep + MASK : all;
  });
  const base = head + path;
  const query = m[2]
    ? '?' +
      m[2]
        .slice(1)
        .split('&')
        .map((kv) => (kv.includes('=') ? `${kv.slice(0, kv.indexOf('='))}=${MASK}` : kv ? MASK : kv))
        .join('&')
    : '';
  return base + query + (m[3] ? `#${MASK}` : '');
}

/** SQL 의 리터럴(문자열·숫자·blob)을 ? 로 바꿔 구조만 남긴다 */
export function redactSql(sql: string): string {
  return sql
    .replace(/[xX]'[0-9a-fA-F]*'/g, '?')
    .replace(/'(?:[^']|'')*'?/g, '?')
    // SQLite 는 같은 이름의 컬럼이 없으면 "…" 도 문자열로 받는다. 값 자리(=, VALUES, IN 뒤)의 것만 가린다
    .replace(/((?:=|<|>|\(|,|\bvalues|\bin|\blike)\s*)"(?:[^"]|"")*"/gi, '$1?')
    .replace(/(?<![\w.$])-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w.])/gi, '?');
}
