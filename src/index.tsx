/* @refresh reload */
import { render } from 'solid-js/web';

import './styles/global.css';
import './styles/app.css';

import App from './App';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Chroma: #root element missing from index.html');
}

render(() => <App />, root);
