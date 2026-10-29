import type { SVGProps } from "react";
export default function HeadscaleLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="38"
        height="38"
        rx="9"
        className="fill-background stroke-border"
        strokeWidth="2"
      />
      <path
        d="M11 14.5L20 9l9 5.5v11L20 31l-9-5.5v-11Z"
        className="fill-accent stroke-primary"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M15 15v10M25 15v10M15 20h10"
        className="stroke-accent-foreground"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <circle cx="20" cy="9" r="2.4" className="fill-primary" />
      <circle cx="11" cy="25.5" r="2.4" className="fill-primary" />
      <circle cx="29" cy="25.5" r="2.4" className="fill-primary" />
    </svg>
  );
}
