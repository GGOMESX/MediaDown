import { createApp } from 'vue';
import App from './App.vue';
import '../popup/style.css';
import '../options/options.css';
import './history.css';

document.title = browser.i18n.getMessage('historyTitle');
createApp(App).mount('#app');
