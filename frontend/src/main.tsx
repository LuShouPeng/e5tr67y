import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles/theme.css';

const container = document.getElementById('root');
if (container == null) throw new Error('找不到挂载点 #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
