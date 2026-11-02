import { productDescriptors } from "./descriptors";
import type { Locale } from "./locales";
import { getLocaleI18n } from "./runtime";

export type ProductCopy = {
  [Key in keyof typeof productDescriptors]: Key extends "nav"
    ? { [NavKey in keyof typeof productDescriptors.nav]: string }
    : string;
};

/** Validates a built copy object before it leaves the translator. */
export function assertProductCopy(
  value: unknown,
): asserts value is ProductCopy {
  if (value === null || typeof value !== "object")
    throw new Error("Product copy must be an object");
  for (const key of Object.keys(productDescriptors)) {
    if (key === "nav") {
      const nav = Reflect.get(value, "nav");
      if (nav === null || typeof nav !== "object")
        throw new Error("Product copy nav must be an object");
      for (const navKey of Object.keys(productDescriptors.nav))
        if (typeof Reflect.get(nav, navKey) !== "string")
          throw new Error(`Product copy nav.${navKey} must be a string`);
    } else if (typeof Reflect.get(value, key) !== "string") {
      throw new Error(`Product copy ${key} must be a string`);
    }
  }
}

export function getProductCopy(locale: Locale): ProductCopy {
  const translator = getLocaleI18n(locale);
  const { nav, ...messages } = productDescriptors;
  const copy: unknown = {
    nav: Object.fromEntries(
      Object.entries(nav).map(([key, message]): [string, string] => [
        key,
        translator._(message.id),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(messages).map(([key, message]): [string, string] => [
        key,
        translator._(message.id),
      ]),
    ),
  };
  assertProductCopy(copy);
  return copy;
}

// English product copy, for tests and callers that need the source-language strings.
export const englishCopy = getProductCopy("en-US");
