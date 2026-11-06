/** Node tests import the real UI modules, whose chart/editor packages ship CSS. */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default "";', shortCircuit: true };
  return nextLoad(url, context);
}
