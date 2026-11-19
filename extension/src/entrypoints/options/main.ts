import { createApp } from 'vue';
import App from './App.vue';
import '../popup/style.css';
import './options.css';

document.title = browser.i18n.getMessage('optionsTitle');
createApp(App).mount('#app');
