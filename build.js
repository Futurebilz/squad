const fs = require('node:fs');
const path = require('node:path');

const bootstrapCss = path.join(__dirname, 'node_modules', 'bootstrap', 'dist', 'css', 'bootstrap.min.css');
const capacitorCore = path.join(__dirname, 'node_modules', '@capacitor', 'core', 'dist', 'index.js');
const splashPluginDirectory = path.join(__dirname, 'node_modules', '@capacitor', 'splash-screen', 'dist', 'esm');
const vendorDirectory = path.join(__dirname, 'www', 'vendor');
const splashVendorDirectory = path.join(vendorDirectory, 'capacitor-splash-screen');
const logoSource = path.join(__dirname, '6819650.png');
const androidResourceDirectory = path.join(__dirname, 'android', 'app', 'src', 'main', 'res');

fs.mkdirSync(vendorDirectory, { recursive: true });
fs.mkdirSync(splashVendorDirectory, { recursive: true });
fs.copyFileSync(bootstrapCss, path.join(vendorDirectory, 'bootstrap.min.css'));
fs.copyFileSync(capacitorCore, path.join(vendorDirectory, 'capacitor-core.js'));
for (const fileName of ['index.js', 'web.js', 'definitions.js']) {
	let source = fs.readFileSync(path.join(splashPluginDirectory, fileName), 'utf8');
	source = source.replaceAll("'@capacitor/core'", "'../capacitor-core.js'");
	source = source.replaceAll("'./web'", "'./web.js'");
	source = source.replaceAll("'./definitions'", "'./definitions.js'");
	fs.writeFileSync(path.join(splashVendorDirectory, fileName), source);
}
fs.copyFileSync(logoSource, path.join(__dirname, 'www', '6819650.png'));
if (fs.existsSync(androidResourceDirectory)) {
	const iconDirectory = path.join(androidResourceDirectory, 'drawable-nodpi');
	fs.mkdirSync(iconDirectory, { recursive: true });
	fs.copyFileSync(logoSource, path.join(iconDirectory, 'gsquad_logo.png'));
}
console.log('Bundled Bootstrap CSS and the G-squad logo into www/.');