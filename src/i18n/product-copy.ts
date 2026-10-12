import { productDescriptors } from "./descriptors";
import type { Locale } from "./locales";
import { getLocaleI18n } from "./runtime";

export type ProductCopy = {
  [Key in keyof typeof productDescriptors]: Key extends "nav"
    ? { [NavKey in keyof typeof productDescriptors.nav]: string }
    : string;
};

export function getProductCopy(locale: Locale): ProductCopy {
  const translator = getLocaleI18n(locale);
  const { nav, ...messages } = productDescriptors;
  return {
    nav: Object.fromEntries(
      Object.entries(nav).map(([key, message]) => [key, translator._(message.id)]),
    ),
    ...Object.fromEntries(
      Object.entries(messages).map(([key, message]) => [key, translator._(message.id)]),
    ),
  } as ProductCopy;
}

// English product copy, for tests and callers that need the source-language strings.
export const englishCopy = getProductCopy("en-US");
