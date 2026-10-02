import { Option, Schema } from "effect";

const ReadRequest = Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(2048)) });

const invalid = () => Response.json({ error: "A public HTTPS URL without credentials is required" }, { status: 400 });

async function boundedBody(request: Request | Response, limit: number): Promise<string | undefined> {
  const reader = request.body?.getReader();

  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) break;
      length += next.value.byteLength;

      if (length > limit) { await reader.cancel();

 return undefined; }

      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }

  const combined = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }

  return new TextDecoder().decode(combined);
}

const DnsResponse = Schema.Struct({ Answer: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.Number, data: Schema.String }))) });

function publicAddress(address: string) {
  if (address.includes(":")) return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:)/i.test(address);
  const [first = 0, second = 0] = address.split(".").map(Number);

  return first > 0 && first < 224 && first !== 10 && first !== 127 && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && [0, 168].includes(second)) && !(first === 100 && second >= 64 && second <= 127) && !(first === 198 && [18, 19, 51].includes(second)) && !(first === 203 && second === 0);
}

async function resolvesPublicly(hostname: string) {
  const answers = await Promise.all(["A", "AAAA"].map(async type => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { Accept: "application/dns-json" } });

    if (!response.ok) throw new Error("Public DNS lookup failed");
    const input = Schema.decodeUnknownSync(DnsResponse)(await response.json());

    return (input.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
  }));

  const addresses = answers.flat();

  return addresses.length > 0 && addresses.every(publicAddress);
}

export async function readWithKitesurf(request: Request, browser: BrowserRun): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > 4096) return invalid();
  const body = await boundedBody(request, 4096);

  if (body === undefined) return invalid();
  const input = Schema.decodeUnknownOption(Schema.fromJsonString(ReadRequest))(body);

  if (Option.isNone(input)) return invalid();
  let url: URL;

  try { url = new URL(input.value.url); } catch { return invalid(); }

  const hostname = url.hostname.toLowerCase();

  if (url.protocol !== "https:" || url.username || url.password || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(hostname) || hostname.endsWith(".ts.net")) return invalid();

  if (!await resolvesPublicly(hostname)) return invalid();
  const originPattern = `^https://${hostname.replaceAll(".", "\\.")}(?::443)?/`;

  const response = await browser.quickAction("markdown", {
    browser: "kitesurf", url: url.href,
    allowRequestPattern: [originPattern],
    gotoOptions: { timeout: 15_000, waitUntil: "domcontentloaded" },
    actionTimeout: 15_000, cacheTTL: 0,
  });

  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Labora-Browser": "kitesurf", "X-Content-Type-Options": "nosniff" });
  const usage = response.headers.get("X-Browser-Ms-Used");

  if (usage) headers.set("X-Browser-Ms-Used", usage);
  const result = await boundedBody(response, 2_097_152);

  if (result === undefined) return Response.json({ error: "Page exceeded the 2 MiB read limit" }, { status: 413 });

  return new Response(result, { status: response.status, headers });
}
