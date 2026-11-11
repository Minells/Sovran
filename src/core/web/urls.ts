import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import { ToolError } from '../tools/types';

/** Conservative public-address policy: transition mechanisms and special-purpose networks are excluded. */
export function publicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  if (ip.kind() === 'ipv6') {
    const v6 = ip as ipaddr.IPv6;
    return (
      v6.match(ipaddr.IPv6.parse('2000::'), 3) &&
      !['2001::/23', '2002::/16', '3fff::/20'].some((cidr) => v6.match(ipaddr.IPv6.parseCIDR(cidr)))
    );
  }
  return !['192.0.0.0/24', '192.88.99.0/24'].some((cidr) =>
    (ip as ipaddr.IPv4).match(ipaddr.IPv4.parseCIDR(cidr)),
  );
}

export function webUrl(input: string): URL {
  // eslint-disable-next-line no-control-regex -- URL controls must be rejected before WHATWG normalization.
  if (input.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(input))
    throw new ToolError('Use an HTTP(S) URL of at most 2048 characters, without whitespace or backslashes.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ToolError('Invalid public Web URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new ToolError('Use a public HTTP(S) URL on its default port, without embedded credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !host ||
    host.endsWith('.') ||
    host.includes('%') ||
    (!isIP(host) &&
      (!host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|home|test|invalid|example|onion)$/i.test(host)))
  )
    throw new ToolError('Local, internal and reserved hostnames are unavailable to web_fetch.');
  if (isIP(host) && !publicAddress(host))
    throw new ToolError('web_fetch only accepts public Internet destinations.');
  url.hash = '';
  return url;
}
