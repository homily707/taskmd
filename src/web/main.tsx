import { createRoot } from 'react-dom/client';
import { createHttpPort } from '../adapters/http.js';
import { TaskmdApp } from '../ui/taskmd-app.js';

const container = document.getElementById('root');
if (!container) throw new Error('taskmd: the #root element is missing from the page shell.');

// The standalone server has no DSH session services, so the session capability
// is intentionally absent; the UI hides every session affordance without it.
const port = createHttpPort();

createRoot(container).render(<TaskmdApp port={port} />);
