import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { boardId, isLanClient } from './navigation';
import { LanSession } from './LanSession';
import { initializeTheme } from './theme';
import { initializeSelectionHdr } from './selectionHdr';
import './styles.css';
import './light-theme.css';
initializeTheme();
initializeSelectionHdr();
const Page = boardId
  ? lazy(() => import('./App').then(module => ({ default: module.App })))
  : lazy(() => import('./Workspace'));
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <Suspense fallback={<div className="workspace-loading" role="status">正在打开 MshTV…</div>}>
    {isLanClient ? <LanSession><Page/></LanSession> : <Page/>}
  </Suspense>
</React.StrictMode>);
