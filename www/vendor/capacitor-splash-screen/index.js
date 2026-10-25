import { registerPlugin } from '../capacitor-core.js';
const SplashScreen = registerPlugin('SplashScreen', {
    web: () => import('./web.js').then(m => new m.SplashScreenWeb()),
});
export * from './definitions.js';
export { SplashScreen };
//# sourceMappingURL=index.js.map