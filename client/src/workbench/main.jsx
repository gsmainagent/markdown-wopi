import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import './workbench.css';
const root=createRoot(document.getElementById('root'));root.render(<App/>);
if(import.meta.hot)import.meta.hot.dispose(()=>root.unmount());
