import * as os from 'os'
import * as prettier from 'prettier'

import { GenerateArgs, ModelMap, ContextDefinition } from '../types'
import { GraphQLTypeField, GraphQLTypeObject } from '../source-helper'
import {
  renderDefaultResolvers,
  getContextName,
  getModelName,
  TypeToInputTypeAssociation,
  InputTypesMap,
  printFieldLikeType,
  getDistinctInputTypes,
  renderEnums,
  groupModelsNameByImportPath,
} from './common'
import { TypeAliasDefinition } from '../introspection/types'
import { upperFirst } from '../utils'

export function format(code: string, options: prettier.Options = {}) {
  try {
    return prettier.format(code, {
      ...options,
      parser: 'typescript',
    })
  } catch (e) {
    console.log(
      `There is a syntax error in generated code, unformatted code printed, error: ${JSON.stringify(
        e,
      )}`,
    )
    return code
  }
}

export function generate(args: GenerateArgs): string {
  // TODO: Maybe move this to source helper
  const inputTypesMap: InputTypesMap = args.types
    .filter(type => type.type.isInput)
    .reduce((inputTypes, type) => {
      return {
        ...inputTypes,
        [`${type.name}`]: type,
      }
    }, {})

  // TODO: Type this
  const typeToInputTypeAssociation: TypeToInputTypeAssociation = args.types
    .filter(
      type =>
        type.type.isObject &&
        type.fields.filter(
          field => field.arguments.filter(arg => arg.type.isInput).length > 0,
        ).length > 0,
    )
    .reduce((types, type) => {
      return {
        ...types,
        [`${type.name}`]: [].concat(
          ...(type.fields.map(field =>
            field.arguments
              .filter(arg => arg.type.isInput)
              .map(arg => arg.type.name),
          ) as any),
        ),
      }
    }, {})

  return `\
  ${renderHeader(args)}

  ${renderEnums(args)}

  ${renderNamespaces(args, typeToInputTypeAssociation, inputTypesMap)}

  ${renderResolvers(args)}

  `
}

function renderHeader(args: GenerateArgs): string {
  const modelsToImport = Object.keys(args.modelMap)
    .filter(modelName => {
      const modelDef = args.modelMap[modelName].definition

      return !(
        modelDef.kind === 'TypeAliasDefinition' &&
        (modelDef as TypeAliasDefinition).isEnum
      )
    })
    .map(modelName => args.modelMap[modelName])
  const modelsByImportPaths = groupModelsNameByImportPath(modelsToImport)

  const modelImports = Object.keys(modelsByImportPaths)
    .map(
      importPath =>
        `import { ${modelsByImportPaths[importPath].join(
          ', ',
        )} } from '${importPath}'`,
    )
    .join(os.EOL)

  return `
// Code generated by github.com/prisma/graphqlgen, DO NOT EDIT.

import { GraphQLResolveInfo } from 'graphql'
${modelImports}
${renderContext(args.context)}
  `
}

function renderContext(context?: ContextDefinition) {
  if (context) {
    return `import { ${getContextName(context)} } from '${context.contextPath}'`
  }

  return `type ${getContextName(context)} = any`
}

function renderNamespaces(
  args: GenerateArgs,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
): string {
  return args.types
    .filter(type => type.type.isObject)
    .map(type =>
      renderNamespace(type, typeToInputTypeAssociation, inputTypesMap, args),
    )
    .join(os.EOL)
}

function renderNamespace(
  graphQLTypeObject: GraphQLTypeObject,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  args: GenerateArgs,
): string {
  return `\
    export namespace ${graphQLTypeObject.name}Resolvers {

    ${renderDefaultResolvers(graphQLTypeObject, args, 'defaultResolvers')}

    ${renderInputTypeInterfaces(
      graphQLTypeObject,
      args.modelMap,
      typeToInputTypeAssociation,
      inputTypesMap,
    )}

    ${renderInputArgInterfaces(graphQLTypeObject, args.modelMap)}

    ${renderResolverFunctionInterfaces(
      graphQLTypeObject,
      args.modelMap,
      args.context,
    )}

    ${renderResolverTypeInterface(
      graphQLTypeObject,
      args.modelMap,
      args.context,
    )}

    ${/* TODO renderResolverClass(type, modelMap) */ ''}
  }
  `
}

function renderInputTypeInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
) {
  if (!typeToInputTypeAssociation[type.name]) {
    return ``
  }

  return getDistinctInputTypes(type, typeToInputTypeAssociation, inputTypesMap)
    .map(typeAssociation => {
      return `export interface ${inputTypesMap[typeAssociation].name} {
      ${inputTypesMap[typeAssociation].fields.map(
        field => `${field.name}: ${printFieldLikeType(field, modelMap)}`,
      )}
    }`
    })
    .join(os.EOL)
}

function renderInputArgInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return type.fields
    .map(field => renderInputArgInterface(field, modelMap))
    .join(os.EOL)
}

function renderInputArgInterface(
  field: GraphQLTypeField,
  modelMap: ModelMap,
): string {
  if (field.arguments.length === 0) {
    return ''
  }

  return `
  export interface Args${upperFirst(field.name)} {
    ${field.arguments
      .map(
        arg =>
          `${arg.name}: ${printFieldLikeType(
            arg as GraphQLTypeField,
            modelMap,
          )}`,
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverFunctionInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return type.fields
    .map(field =>
      renderResolverFunctionInterface(field, type, modelMap, context),
    )
    .join(os.EOL)
}

function renderResolverFunctionInterface(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  const resolverName = `${upperFirst(field.name)}Resolver`
  const resolverDefinition = `
  (
    parent: ${getModelName(type.type as any, modelMap, 'undefined')},
    args: ${
      field.arguments.length > 0 ? `Args${upperFirst(field.name)}` : '{}'
    },
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  )
  `
  const returnType = printFieldLikeType(field, modelMap)

  if (type.name === 'Subscription') {
    return `
    export type ${resolverName} = {
      subscribe: ${resolverDefinition} => AsyncIterator<${returnType}> | Promise<AsyncIterator<${returnType}>>
      resolve?: ${resolverDefinition} => ${returnType} | Promise<${returnType}>
    }
    `
  }

  return `
  export type ${resolverName} = ${resolverDefinition} => ${returnType} | Promise<${returnType}>
  `
}

function renderResolverTypeInterface(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return `
  export interface Type {
    ${type.fields
      .map(field =>
        renderResolverTypeInterfaceFunction(field, type, modelMap, context),
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverTypeInterfaceFunction(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  const resolverDefinition = `
  (
    parent: ${getModelName(type.type as any, modelMap, 'undefined')},
    args: ${
      field.arguments.length > 0 ? `Args${upperFirst(field.name)}` : '{}'
    },
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  )
  `
  const returnType = printFieldLikeType(field, modelMap)

  if (type.name === 'Subscription') {
    return `
    ${field.name}: {
      subscribe: ${resolverDefinition} => AsyncIterator<${returnType}> | Promise<AsyncIterator<${returnType}>>
      resolve?: ${resolverDefinition} => ${returnType} | Promise<${returnType}>
    }
    `
  }

  return `
    ${
      field.name
    }: ${resolverDefinition} => ${returnType} | Promise<${returnType}>
  `
}

function renderResolvers(args: GenerateArgs): string {
  return `
export interface Resolvers {
  ${args.types
    .filter(type => type.type.isObject)
    .map(type => `${type.name}: ${type.name}Resolvers.Type`)
    .join(os.EOL)}
}
  `
}
