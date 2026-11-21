import { config } from "@elgato/eslint-config";

export default [
	{
		ignores: [
			"dist/**",
			"node_modules/**",
			"fixtures/**/bin/**",
			"tools/oxlint/anti-slop/**",
		],
	},
	...config.strict,
	{
		files: ["src/**/*.ts"],
		rules: {
			"jsdoc/no-undefined-types": "off",
			"jsdoc/require-jsdoc": "off",
			"jsdoc/require-param": "off",
			"jsdoc/require-returns": "off",
		},
	},
];
