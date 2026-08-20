# Procedure to compile Game for js13kgame challenge

## Activate the minimal right version of node.js

```powershell
PS D:\git_projects\chromatic-crawl> nvm current
v14.17.0
PS D:\git_projects\chromatic-crawl> nvm install 20.18.2
Downloading node.js version 20.18.2 (64-bit)... 
Extracting node and npm...
Complete
npm v10.8.2 installed successfully.


Installation complete. If you want to use this version, type

nvm use 20.18.2

PS D:\git_projects\chromatic-crawl> nvm use 20.18.2
Now using node v20.18.2 (64-bit)
PS D:\git_projects\chromatic-crawl> nvm current
v20.18.2
PS D:\git_projects\chromatic-crawl>
```

## Set the project to use ESM approach

### Install prerequisites

npm i kontra
npm i -D rollup @rollup/plugin-node-resolve terser

```powershell
PS D:\git_projects\chromatic-crawl> npm i kontra

added 1 package in 2s
PS D:\git_projects\chromatic-crawl> npm i -D rollup @rollup/plugin-node-resolve terser

added 27 packages, and audited 29 packages in 5s

5 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
PS D:\git_projects\chromatic-crawl> 
```

### Build with rollup

npx rollup ./assets/js/game.js --file ./dist/game.bundle.js --format iife --plugin @rollup/plugin-node-resolve

```powershell
PS D:\git_projects\chromatic-crawl> npx rollup ./assets/js/game.js --file ./dist/game.bundle.js --format iife --plugin @rollup/plugin-node-resolve

./assets/js/game.js → ./dist/game.bundle.js...
created ./dist/game.bundle.js in 370ms
PS D:\git_projects\chromatic-crawl>
```

### Minify with terser

npx terser ./dist/game.bundle.js -o ./dist/game.min.js --compress --mangle

```powershell
PS D:\git_projects\chromatic-crawl> npx terser ./dist/game.bundle.js -o ./dist/game.min.js --compress --mangle
PS D:\git_projects\chromatic-crawl>
```

### Integrate final code inside index.html

remove all references to kontra in "index.html" file.
replace the content of HTML tag "script"

```html
<script>
/* paste the contents of dist/game.min.js here */
</script>
```

### Create the zipped archive of final result

I won't tell you how to zip a file.
