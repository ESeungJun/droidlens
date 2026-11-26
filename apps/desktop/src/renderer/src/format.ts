const pad = (n: number) => String(n).padStart(2, '0');

/** 표·목록용 짧은 시각: 올해면 "11/23 17:10", 아니면 "2025/11/23 17:10". 좁은 칸에서도 줄이 바뀌지 않는 길이. */
export function shortTime(at: number | string): string {
  const d = new Date(at);
  const day = `${d.getMonth() + 1}/${d.getDate()}`;
  const date = d.getFullYear() === new Date().getFullYear() ? day : `${d.getFullYear()}/${day}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 링크를 사람이 읽을 이름으로: 마지막 경로 조각을 풀어 쓴다 (Confluence 는 페이지 제목이 들어 있다). */
export function linkName(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.length ? decodeURIComponent(parts[parts.length - 1].replace(/\+/g, ' ')).trim() : '';
    return last && !/^\d+$/.test(last) ? last : u.hostname;
  } catch {
    return url;
  }
}
