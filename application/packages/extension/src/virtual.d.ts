declare module 'virtual:pn-catalogs' {
  const resources: Record<string, Record<string, Record<string, unknown>>>;
  export default resources;
}

/** The app's build-platform define (packages/web/vite.config.ts); the extension sets it to '' in wxt.config.ts. */
declare const __PN_BUILD_PLATFORM__: string;
