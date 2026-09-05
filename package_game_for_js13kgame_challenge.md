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

## Optimizing the size of the artefact

### Optimizing image assets to shrink overall file size

```bash
sudo apt install advancecomp
mkdir -p /tmp/pngopt
for f in assets/img/*.png; do
  cp "$f" /tmp/pngopt/
done
for f in /tmp/pngopt/*.png; do
  advdef -z -4 "$f" > /dev/null
done
echo "---png sizes before/after---"
for f in assets/img/*.png; do base=$(basename "$f"); orig=$(wc -c < "$f"); opt=$(wc -c < /tmp/pngopt/"$base"); echo "$base: $orig -> $opt"; done
```

### Optimizing PNG file sizes through layered compression tools

```bash
apt-get install -y pngcrush optipng 2>&1 | tail -3
which pngcrush optipng oxipng pngquant 2>&1
```

### Compressing image files to shrink their sizes

```bash
cd /tmp/pngopt
for f in *.png; do cp "$f" "opt_$f"; done
for f in opt_*.png; do optipng -o7 -strip all "$f" > /dev/null 2>&1; done
echo "---after optipng -o7---"
for f in *.png; do 
  if [[ "$f" != opt_* ]]; then
    base="opt_$f"
    b1=$(wc -c < "$f")
    b2=$(wc -c < "$base")
    echo "$f: $b1 -> $b2"
  fi
done
```

```bash
cd /tmp/pngopt
for f in creature-sheet.png gold_pot_32x16.png leprechaun_64x16.png piskel-unicorn.png; do
  b1=$(wc -c < "$f")
  b2=$(wc -c < "opt_$f")
  echo "$f: $b1 -> $b2"
done
```

### Optimizing image files for smaller storage size

```bash
cd /tmp/pngopt
for f in opt_creature-sheet.png opt_gold_pot_32x16.png opt_leprechaun_64x16.png opt_piskel-unicorn.png; do
  advdef -z -4 "$f" > /dev/null
done
echo "---final png sizes---"
for f in opt_*.png; do wc -c < "$f" | tr -d '\n'; echo " $f"; done
echo "---total---"
cat opt_creature-sheet.png opt_gold_pot_32x16.png opt_leprechaun_64x16.png opt_piskel-unicorn.png | wc -c
```

### Confirmed pixel-identical — fully lossless

```bash
sudo apt install -y python3-pil

python3 -c "
from PIL import Image
import sys
pairs = [
  ('assets/img/creature-sheet.png','/tmp/pngopt/opt_creature-sheet.png'),
  ('assets/img/gold_pot_32x16.png','/tmp/pngopt/opt_gold_pot_32x16.png'),
  ('assets/img/leprechaun_64x16.png','/tmp/pngopt/opt_leprechaun_64x16.png'),
  ('assets/img/piskel-unicorn.png','/tmp/pngopt/opt_piskel-unicorn.png'),
]
for a,b in pairs:
    ia = Image.open(a).convert('RGBA')
    ib = Image.open(b).convert('RGBA')
    print(a, ia.size, ib.size, list(ia.getdata())==list(ib.getdata()))
"
```

## Create the zipped archive of final result

Finally there is some tips even for ziping the global package.

### First we create the zip package

```bash
zip -X -9 submission.zip dist/index.html dist/assets/img/*.png
```

### Finally we optimize the global package

```bash
advzip -z -4 submission.zip
```
