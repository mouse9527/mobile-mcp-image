// Unit test for screen.js trimming (ELEMENTS_TRIM=1), synthetic element list in mobile-mcp 1.0.12's text format.
"use strict";
process.env.ELEMENTS_TRIM = "1";
const assert = require("node:assert");
const { trimElements } = require("../screen.js");

const H = "One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]";
const list = [H,
	'@e1 android.widget.FrameLayout id="com.shop.app:id/root" at=0,0 size=1200x2670',
	'@e2 android.widget.FrameLayout id="com.shop.app:id/card" at=0,300 size=600x800',
	'@e3 android.widget.FrameLayout at=0,300 size=600x800',
	'@e4 android.widget.FrameLayout at=0,300 size=600x800',
	'@e5 android.widget.TextView text="Wireless earbuds, 3rd generation" id="com.shop.app:id/title" at=20,820 size=560x80',
	'@e6 android.widget.TextView text="¥1549.00" label="¥1549.00" id="com.shop.app:id/price" at=20,910 size=200x60',
	'@e7 android.widget.EditText at=100,120 size=800x90 focused',
	'@e8 android.widget.ImageView label="Share" at=1065,133 size=120x138',
	'@e9 android.view.View at=5,5 size=0x0',
].join("\n");

const out = trimElements(list);
const lines = out.split("\n");
assert.ok(lines[0].includes("c=centerX,centerY"), "header explains c=");
assert.ok(!out.includes("@e3 ") && !out.includes("@e4 "), "same-place duplicates dropped");
assert.ok(!out.includes("@e9 "), "zero-size dropped");
for (const s of ['"Wireless earbuds, 3rd generation"', '"¥1549.00"', '"Share"']) assert.ok(out.includes(s), "kept " + s);
assert.ok(out.includes('@e5 TextView text="Wireless earbuds, 3rd generation" id="title" c=300,860 size=560x80'), "short id, centre, short type");
assert.ok(out.includes('@e6 TextView text="¥1549.00" id="price"'), "label equal to text written once");
assert.ok(out.includes("@e7 EditText c=500,165 size=800x90 focused"), "textless input kept with its flag");
assert.ok(out.includes('@e8 ImageView label="Share" c=1125,202'), "icon with label kept");
assert.ok(out.includes("@e2 "), "first of the duplicates kept with its ref");
// embedded in batch output: only the list part is rewritten
const batch = "Clicked on element @e5\n" + list + "\nTyped text";
const bo = trimElements(batch);
assert.ok(bo.startsWith("Clicked on element @e5\n") && bo.endsWith("\nTyped text") && bo.includes("c=300,860"), "batch");
// no list -> untouched
assert.strictEqual(trimElements("Clicked on screen"), "Clicked on screen");
console.log("ok: element trimming (dedupe, zero-size, short id, centre, label==text, inputs / icons kept, batch, untouched otherwise)");
