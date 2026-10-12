import { Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { type ThemeMode, themeModes, useTheme } from "@/composables/useTheme";
import { LOCALE_META, SUPPORTED_LOCALES, useHeadscaleI18n } from "@/i18n";

interface ChosenProps {
  onChosen?: () => void;
}

export function ThemeModeIcon({ mode, className }: { mode: ThemeMode; className?: string }) {
  if (mode === "light") return <Sun className={className} aria-hidden="true" />;
  if (mode === "dark") return <Moon className={className} aria-hidden="true" />;
  return <Monitor className={className} aria-hidden="true" />;
}

export function themeModeLabel(t: (key: "dark" | "light" | "system") => string, mode: ThemeMode) {
  if (mode === "dark") return t("dark");
  if (mode === "light") return t("light");
  return t("system");
}

export function LocaleRadioItems({ onChosen }: ChosenProps) {
  const { locale, setLocale } = useHeadscaleI18n();
  return (
    <DropdownMenuRadioGroup value={locale}>
      {SUPPORTED_LOCALES.map((option) => (
        <DropdownMenuRadioItem
          key={option}
          value={option}
          closeOnClick
          data-testid={`locale-option-${option}`}
          onClick={() => {
            void setLocale(option);
            onChosen?.();
          }}
        >
          {LOCALE_META[option].nativeLabel}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

export function ThemeRadioItems({ onChosen }: ChosenProps) {
  const { t } = useHeadscaleI18n();
  const { colorMode, setTheme } = useTheme();
  return (
    <DropdownMenuRadioGroup value={colorMode}>
      {themeModes.map((mode) => (
        <DropdownMenuRadioItem
          key={mode}
          value={mode}
          closeOnClick
          data-testid={`theme-option-${mode}`}
          onClick={() => {
            void setTheme(mode);
            onChosen?.();
          }}
        >
          <ThemeModeIcon mode={mode} className="h-4 w-4" />
          {themeModeLabel(t, mode)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
