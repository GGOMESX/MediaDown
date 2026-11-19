import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'pt_BR',
    permissions: ['webRequest', 'storage', 'activeTab', 'downloads'],
    // Personal build: media usually comes from a CDN on a different origin than the page,
    // and webRequest only sees hosts it has permission for. A store build must switch this
    // to optional_host_permissions requested from the popup.
    host_permissions: ['<all_urls>'],
  },
});
