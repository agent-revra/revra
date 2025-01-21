import * as z from 'zod';

import { parseAllOf } from './parse-all-of.js';
import { parseAnyOf } from './parse-any-of.js';
import { parseArray } from './parse-array.js';
import { parseBoolean } from './parse-boolean.js';
import { parseConst } from './parse-const.js';
import { parseDefault } from './parse-default.js';
import { parseEnum } from './parse-enum.js';
import { parseIfThenElse } from './parse-if-then-else.js';
import { parseMultipleType } from './parse-multiple-type.js';
import { parseNot } from './parse-not.js';
import { parseNull } from './parse-null.js';
import { parseNullable } from './parse-nullable.js';
import { parseNumber } from './parse-number.js';
import { parseObject } from './parse-object.js';
import { parseOneOf } from './parse-one-of.js';
import { parseString } from './parse-string.js';
import type { ParserSelector, Refs, JsonSchemaObject, JsonSchema } from '../types.js';
import { its } from '../utils/its.js';

const addDescribes = (jsonSchema: JsonSchemaObject, zodSchema: z.ZodTypeAny): z.ZodTypeAny => {
	if (jsonSchema.description) {
		zodSchema = zodSchema.describe(jsonSchema.description);
	}

	return zodSchema;
};

const addDefaults = (jsonSchema: JsonSchemaObject, zodSchema: z.ZodTypeAny): z.ZodTypeAny => {
	if (jsonSchema.default !== undefined) {
		zodSchema = zodSchema.default(jsonSchema.default);
	}

	return zodSchema;
};

const addAnnotations = (jsonSchema: JsonSchemaObject, zodSchema: z.ZodTypeAny): z.ZodTypeAny => {
	if (jsonSchema.readOnly) {
		zodSchema = zodSchema.readonly();
	}

	return zodSchema;
};

const selectParser: ParserSelector = (schema, refs) => {
	if (its.a.nullable(schema)) {
		return parseNullable(schema, refs);
	} else if (its.an.object(schema)) {
		return parseObject(schema, refs);
	} else if (its.an.array(schema)) {
		return parseArray(schema, refs);
	} else if (its.an.anyOf(schema)) {
		return parseAnyOf(schema, refs);
	} else if (its.an.allOf(schema)) {
		return parseAllOf(schema, refs);
	} else if (its.a.oneOf(schema)) {
		return parseOneOf(schema, refs);
	} else if (its.a.not(schema)) {
		return parseNot(schema, refs);
	} else if (its.an.enum(schema)) {
		return parseEnum(schema); //<-- needs to come before primitives
	} else if (its.a.const(schema)) {
		return parseConst(schema);
	} else if (its.a.multipleType(schema)) {
		return parseMultipleType(schema, refs);
	} else if (its.a.primitive(schema, 'string')) {
		return parseString(schema);
	} else if (its.a.primitive(schema, 'number') || its.a.primitive(schema, 'integer')) {
		return parseNumber(schema);
	} else if (its.a.primitive(schema, 'boolean')) {
		return parseBoolean(schema);
	} else if (its.a.primitive(schema, 'null')) {
		return parseNull(schema);
	} else if (its.a.conditional(schema)) {
		return parseIfThenElse(schema, refs);
	} else {
		return parseDefault(schema);
	}
};

export const parseSchema = (
	jsonSchema: JsonSchema,
	refs: Refs = { seen: new Map(), path: [] },
	blockMeta?: boolean,
): z.ZodTypeAny => {
	if (typeof jsonSchema !== 'object') return jsonSchema ? z.any() : z.never();

	if (refs.parserOverride) {
		const custom = refs.parserOverride(jsonSchema, refs);

		if (custom instanceof z.ZodType) {
			return custom;
		}
	}

	let seen = refs.seen.get(jsonSchema);

	if (seen) {
		if (seen.r !== undefined) {
			return seen.r;
		}

		if (refs.depth === undefined || seen.n >= refs.depth) {
			return z.any();
		}

		seen.n += 1;
	} else {
		seen = { r: undefined, n: 0 };
		refs.seen.set(jsonSchema, seen);
	}

	let parsedZodSchema = selectParser(jsonSchema, refs);
	if (!blockMeta) {
		if (!refs.withoutDescribes) {
			parsedZodSchema = addDescribes(jsonSchema, parsedZodSchema);
		}

		if (!refs.withoutDefaults) {
			parsedZodSchema = addDefaults(jsonSchema, parsedZodSchema);
		}

		parsedZodSchema = addAnnotations(jsonSchema, parsedZodSchema);
	}

	seen.r = parsedZodSchema;

	return parsedZodSchema;
};
