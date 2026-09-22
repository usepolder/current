import type { CurrentReport } from '@usepolder/current-core';

export const BADGE_DIR = '.current';
export const BADGE_JSON = 'badge.json';
export const BADGE_SVG = 'badge.svg';

export function badgeColor(score: number | null): string {
  if (score === null) return 'lightgrey';
  if (score >= 80) return 'brightgreen';
  if (score >= 60) return 'green';
  if (score >= 40) return 'yellow';
  if (score >= 20) return 'orange';
  return 'red';
}

const HEX: Record<string, string> = {
  brightgreen: '#4c1',
  green: '#97ca00',
  yellow: '#dfb317',
  orange: '#fe7d37',
  red: '#e05d44',
  lightgrey: '#9f9f9f',
};

export function badgeMessage(report: CurrentReport): string {
  return report.totals.overall === null ? 'no data' : `${report.totals.overall.toFixed(1)}%`;
}

/** shields.io endpoint format — public repos embed this with one markdown line. */
export function badgeJson(report: CurrentReport): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      label: 'component health',
      message: badgeMessage(report),
      color: badgeColor(report.totals.overall),
    },
    null,
    2,
  )}\n`;
}

/** Static SVG for private repos, where shields.io cannot fetch the raw JSON. */
export function badgeSvg(report: CurrentReport): string {
  const message = badgeMessage(report);
  const color = HEX[badgeColor(report.totals.overall)];
  const label = 'component health';
  const labelWidth = 103;
  const messageWidth = Math.max(40, message.length * 7 + 10);
  const total = labelWidth + messageWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${message}">
  <title>${label}: ${message}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + messageWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${message}</text>
  </g>
</svg>
`;
}
