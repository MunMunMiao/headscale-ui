import { useMemo } from "react";
import { useHeadscaleI18n } from "@/i18n";
import { getProductCopy, type ProductCopy } from "@/i18n/product-copy";

export interface UseProductCopyReturn {
  copy: ProductCopy;
}

export function useProductCopy(): UseProductCopyReturn {
  const { locale } = useHeadscaleI18n();
  return { copy: useMemo(() => getProductCopy(locale), [locale]) };
}
