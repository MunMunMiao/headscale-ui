import { describe, expect, test } from "bun:test";
import { OPERATION_IDS } from "@/domain/headscale-operations";
import type { LocaleCatalog } from "./catalog";
import { arCatalog } from "./catalogs/ar";
import { esESCatalog } from "./catalogs/es-ES";
import { frFRCatalog } from "./catalogs/fr-FR";
import { itITCatalog } from "./catalogs/it-IT";
import { jaJP } from "./catalogs/ja-JP";
import { koKR } from "./catalogs/ko-KR";
import { ruRU } from "./catalogs/ru-RU";
import { zhHans } from "./catalogs/zh-Hans";
import { zhHantHK } from "./catalogs/zh-Hant-HK";
import { zhHantTW } from "./catalogs/zh-Hant-TW";
import type { Locale } from "./locales";
import {
  commonMessages,
  getGroupLabel,
  getMessage,
  getOperationMessage,
  groupLabels,
  messageKeys,
  operationMessages,
} from "./messages";
import { englishCopy, productCopy } from "./product-copy";

const catalogs = {
  "zh-Hans": zhHans,
  "zh-Hant-TW": zhHantTW,
  "zh-Hant-HK": zhHantHK,
  "ja-JP": jaJP,
  "ko-KR": koKR,
  "fr-FR": frFRCatalog,
  "ru-RU": ruRU,
  "es-ES": esESCatalog,
  "it-IT": itITCatalog,
  ar: arCatalog,
} satisfies Record<Exclude<Locale, "en-US">, LocaleCatalog>;

const englishCatalog: LocaleCatalog = {
  common: messageKeys,
  groups: groupLabels["en-US"],
  operations: operationMessages["en-US"],
  product: englishCopy,
};

function flattenStrings(
  value: unknown,
  path = "",
  result = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "string") {
    result.set(path, value);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenStrings(child, path ? `${path}.${key}` : key, result);
    }
  }
  return result;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{[^{}]+\}/g)].map(([token]) => token).sort();
}

describe("i18n catalogs", () => {
  test("keeps 648 explicit leaves and every placeholder aligned with English", () => {
    const english = flattenStrings(englishCatalog);
    const englishKeys = [...english.keys()].sort();
    expect(english.size).toBe(648);

    for (const catalog of Object.values(catalogs)) {
      const localized = flattenStrings(catalog);
      expect([...localized.keys()].sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(placeholders(localized.get(key) ?? "")).toEqual(
          placeholders(english.get(key) ?? ""),
        );
      }
    }
  });

  test("uses explicit catalog sources without spreads, converters, or English sentences", async () => {
    const english = flattenStrings(englishCatalog);

    for (const [locale, catalog] of Object.entries(catalogs)) {
      const source = await Bun.file(new URL(`./catalogs/${locale}.ts`, import.meta.url)).text();
      expect(source).not.toMatch(/^\s*\.\.\./m);
      expect(source).not.toMatch(
        /englishCopy|messageKeys|toTraditionalChinese|commonMessages|productCopy/,
      );

      const localized = flattenStrings(catalog);
      const unchangedSentences = [...english].filter(
        ([key, value]) =>
          localized.get(key) === value && /[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(value),
      );
      expect(unchangedSentences).toEqual([]);
    }
  });

  test("locks localized device terminology and regional Traditional Chinese", () => {
    expect(
      Object.fromEntries(
        Object.entries(catalogs).map(([locale, catalog]) => [locale, catalog.product.nav.devices]),
      ),
    ).toEqual({
      "zh-Hans": "设备",
      "zh-Hant-TW": "裝置",
      "zh-Hant-HK": "設備",
      "ja-JP": "デバイス",
      "ko-KR": "기기",
      "fr-FR": "Appareils",
      "ru-RU": "Устройства",
      "es-ES": "Dispositivos",
      "it-IT": "Dispositivi",
      ar: "الأجهزة",
    });
    expect(zhHans.product.optionGroupLabels).toBe("设备标签");
    expect(esESCatalog.product.optionGroupLabels).toBe("Etiquetas de dispositivo");
    expect(zhHantTW.product.refreshData).toBe("重新整理資料");
    expect(zhHantHK.product.refreshData).toBe("重新載入數據");
    expect(zhHantTW).not.toEqual(zhHantHK);
  });

  test("describes the personal-device template as broad access in every language", () => {
    expect(englishCopy.templateSelfOnlyTitle).toBe("Open personal device access");
    expect(englishCopy.templateSelfOnlyDescription).toMatch(/Anyone/);

    const broadAccessPhrases: Record<keyof typeof catalogs, RegExp> = {
      "zh-Hans": /所有用户/,
      "zh-Hant-TW": /所有使用者/,
      "zh-Hant-HK": /所有用戶/,
      "ja-JP": /全員/,
      "ko-KR": /누구나/,
      "fr-FR": /tous les utilisateurs/i,
      "ru-RU": /Любой пользователь/i,
      "es-ES": /cualquier usuario/i,
      "it-IT": /tutti gli utenti|chiunque/i,
      ar: /كل المستخدمين|جميع المستخدمين/,
    };

    for (const [locale, phrase] of Object.entries(broadAccessPhrases) as Array<
      [keyof typeof catalogs, RegExp]
    >) {
      expect(catalogs[locale].product.templateSelfOnlyDescription).toMatch(phrase);
    }
  });

  test("wires every operation to a localized title and description", () => {
    for (const locale of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
      for (const id of OPERATION_IDS) {
        const message = getOperationMessage(locale, id);
        expect(message.title).not.toMatch(/^[A-Z]{2}:/);
        expect(message.description).not.toMatch(/^[A-Z]{2}:/);
      }
    }

    expect(getOperationMessage("ar", "health.check").title).toBe("فحص الصحة");
    expect(getOperationMessage("fr-FR", "node.rename").title).toBe("Renommer l'appareil");
    expect(getOperationMessage("ru-RU", "apikey.create").title).toBe("Создать API-ключ");
    expect(getOperationMessage("es-ES", "policy.set").title).toBe("Guardar política");
  });

  test("exposes each catalog through the runtime maps", () => {
    for (const [locale, catalog] of Object.entries(catalogs) as Array<
      [keyof typeof catalogs, LocaleCatalog]
    >) {
      expect(commonMessages[locale]).toBe(catalog.common);
      expect(groupLabels[locale]).toBe(catalog.groups);
      expect(operationMessages[locale]).toBe(catalog.operations);
      expect(productCopy[locale]).toBe(catalog.product);
    }

    expect(getMessage("en-US", "appTitle")).toBe("Headscale UI");
    expect(getGroupLabel("en-US", "nodes")).toBe("Nodes");
  });
});
