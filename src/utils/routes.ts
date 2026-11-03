/** Headscale's two exit routes; kept here so node helpers do not import status classes. */
export function isExitRoute(route: string): boolean {
  return route === "0.0.0.0/0" || route === "::/0";
}
