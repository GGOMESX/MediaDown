import { defineConfig } from 'wxt';

// Public key only: pins the extension ID (jakijlbgipgbbaldfhhpglollgnldckh) so the companion's
// native messaging manifest can allow exactly this extension, wherever the folder is loaded from.
const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1Rkv5lzFfmVIKuQS+AXa5gJYiRcBZrbbvZs1s/Utg7iCNu+8ppMm4DLzk/u70lvlkWmJqLBSOzYoJkON7Vttk5vhyxQZhGKzC7v39jm6YIW77uI1BXjZUewSFl13HL9I+lvQWvONsf8PrJkm/XgUsfJvfTuLg9DL5N6NzS4Ok7CVEzT63wBIlo7YFA1NGSDPdUME3MP6HNPf7Mf166fHk8N8nA7ffkN0I7u9MkhKkpSjU4oNZ3oaIClg1297z4XOHbKX9/gZUuX5bHtcf0mJCj5vhJVLfDQqsbx3HewDhekQCpFVwrNuWww3w3GonQSht//fcyfW269VX1UoRYn/JwIDAQAB';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'pt_BR',
    key: EXTENSION_PUBLIC_KEY,
    permissions: ['webRequest', 'storage', 'activeTab', 'downloads', 'nativeMessaging'],
    // Personal build: media usually comes from a CDN on a different origin than the page,
    // and webRequest only sees hosts it has permission for. A store build must switch this
    // to optional_host_permissions requested from the popup.
    host_permissions: ['<all_urls>'],
  },
});
