// SSRF guards: private addresses (including IPv6-mapped loopback) never fetch,
// and hostile numeric entities cannot crash the HTML decoder.

import assert from "node:assert/strict";
import { fetchPage, htmlToText, addressIsPrivate } from "../webAccess.js";

assert.equal(addressIsPrivate("127.0.0.1"), true);
assert.equal(addressIsPrivate("::1"), true);
assert.equal(addressIsPrivate("0:0:0:0:0:0:0:1"), true, "expanded IPv6 loopback is still loopback");
assert.equal(addressIsPrivate("::ffff:127.0.0.1"), true);
assert.equal(addressIsPrivate("::ffff:7f00:1"), true, "hex IPv4-mapped 127.0.0.1 is private");
assert.equal(addressIsPrivate("8.8.8.8"), false);

{
  const page = await fetchPage("http://[::ffff:7f00:1]:4100/api/status");
  assert.ok(page.error, "mapped loopback must not fetch: " + JSON.stringify(page));
  assert.match(page.error, /blocked|private|safety/i);
}

{
  const { text } = htmlToText("<p>ok &#999999999; still here</p>");
  assert.match(text, /still here/, "an out-of-range numeric entity must not throw");
}

{
  const { createPinnedLookup } = await import("../webAccess.js");
  const lookup = createPinnedLookup([{ address: "93.184.216.34", family: 4 }]);
  const pinned = await new Promise((resolve, reject) => {
    lookup("rebind.example", { family: 4 }, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
  assert.equal(pinned.address, "93.184.216.34", "connect must use the address we already allowed, not a second DNS answer");
  assert.equal(pinned.family, 4);
}

{
  const { fetchPage: fetchPinned } = await import("../webAccess.js");
  let lookedUp = null;
  const page = await fetchPinned("https://rebind.example/secret", 8000, {
    resolvePublicAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    httpGet: async (u, addrs, extras) => {
      lookedUp = await new Promise((resolve, reject) => {
        extras.lookup(u.hostname, { family: 4 }, (err, address, family) => {
          if (err) reject(err);
          else resolve({ address, family, hostHeader: u.hostname });
        });
      });
      throw new Error("stop-after-pin");
    }
  });
  assert.equal(lookedUp.address, "93.184.216.34");
  assert.equal(lookedUp.hostHeader, "rebind.example", "TLS/Host stay on the original name");
  assert.match(page.error || "", /stop-after-pin|failed/i);
}

console.log("✓ webAccess: IPv6-mapped loopback blocked, hostile entities tolerated, DNS pinned");
