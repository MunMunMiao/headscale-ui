import { expect } from "vitest";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
// Two colons minimum so clock times such as 12:30 do not match.
const IPV6 = /^[0-9a-f]*(:[0-9a-f]*){2,}(\/\d{1,3})?$/i;
const ISOLATING = new Set(["isolate", "isolate-override", "embed", "bidi-override"]);

function firstAndLastLeft(node: Text) {
  const range = document.createRange();
  const length = node.data.length;
  range.setStart(node, 0);
  range.setEnd(node, 1);
  const first = range.getBoundingClientRect();
  range.setStart(node, length - 1);
  range.setEnd(node, length);
  const last = range.getBoundingClientRect();
  return { first: first.left, last: last.left, sameLine: first.top === last.top };
}

/**
 * Asserts every IP address or CIDR rendered under `root` is laid out left-to-right and isolated
 * from the surrounding bidi context (the "0/::" symptom in right-to-left locales).
 */
export function expectNetworkTokensLtr(root: ParentNode, minimum = 1) {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const value = text.data.trim();
    const isIpv6 = IPV6.test(value);
    if (!IPV4.test(value) && !isIpv6) continue;
    count += 1;
    const parent = text.parentElement;
    if (!parent) continue;
    const style = getComputedStyle(parent);
    expect(style.direction, `direction of ${value}`).toBe("ltr");
    expect(ISOLATING.has(style.unicodeBidi), `unicode-bidi of ${value}: ${style.unicodeBidi}`).toBe(
      true,
    );
    if (isIpv6 && text.data.trim().length > 1) {
      const { first, last, sameLine } = firstAndLastLeft(text);
      if (sameLine)
        expect(first, `first character of ${value} is left of the last`).toBeLessThan(last);
    }
  }
  expect(count, "network tokens found").toBeGreaterThanOrEqual(minimum);
}
