import 'reflect-metadata';
import {
  GraphQLModule,
  ModuleConfig,
  ModuleContext,
  OnRequest,
  ModuleConfigRequiredError,
  OnResponse,
  OnInit,
} from '../src';
import { execute, GraphQLSchema, printSchema, GraphQLString, defaultFieldResolver, print, GraphQLScalarType, Kind } from 'graphql';
import { stripWhitespaces } from './utils';
import gql from 'graphql-tag';
import { SchemaDirectiveVisitor, makeExecutableSchema } from 'graphql-tools';
import { ModuleSessionInfo } from '../src/module-session-info';
import { Injectable, Inject, InjectFunction, Injector, ProviderScope, DependencyProviderNotFoundError } from '@graphql-modules/di';
import { SchemaLink } from 'apollo-link-schema';
import { ApolloClient } from 'apollo-client';
import { InMemoryCache } from 'apollo-cache-inmemory';

describe('GraphQLModule', () => {
  // A
  @Injectable()
  class ProviderA {
    doSomething() {
      return 'Test1';
    }
  }

  // B
  @Injectable()
  class ProviderB {
    doSomethingElse() {
      return 'Test2';
    }
  }

  const typesA = [`type A { f: String}`, `type Query { a: A }`];
  const moduleA = new GraphQLModule({
    name: 'A',
    typeDefs: typesA,
    resolvers: ({ injector }) => ({
      Query: { a: () => ({}) },
      A: { f: () => injector.get(ProviderA).doSomething() },
    }),
    providers: [ProviderA],
  });

  // B
  const typesB = [`type B { f: String}`, `type Query { b: B }`];
  const resolversB = {
    Query: { b: () => ({}) },
    B: { f: (root, args, context) => context.user.id },
  };
  let resolverCompositionCalled = false;
  const moduleB = new GraphQLModule({
    name: 'B',
    typeDefs: typesB,
    resolvers: resolversB,
    resolversComposition: {
      'B.f': next => async (root, args, context: ModuleContext, info) => {
        if (context.injector && context.injector.get(ModuleConfig(moduleB))) {
          resolverCompositionCalled = true;
        }
        return next(root, args, context, info);
      },
    },
    imports: () => [
      moduleC,
    ],
  });

  // C (with context building fn)
  const cContextBuilder = () => ({ user: { id: 1 } });
  const typesC = [`type C { f: String}`, `type Query { c: C }`];
  const moduleC = new GraphQLModule({
    name: 'C',
    typeDefs: typesC,
    context: cContextBuilder,
  });

  // D
  const moduleD = new GraphQLModule({
    name: 'D',
    typeDefs: typesC,
    context: () => {
      throw new Error('oops');
    },
  });

  // E
  const moduleE = new GraphQLModule({
    name: 'E',
    typeDefs: typesC,
  });

  // F
  const typeDefsFnMock = jest.fn().mockReturnValue(typesC);
  const resolversFnMock = jest.fn().mockReturnValue({ C: {} });
  const moduleF = new GraphQLModule({
    name: 'F',
    typeDefs: typeDefsFnMock,
    resolvers: resolversFnMock,
  });

  afterEach(() => {
    typeDefsFnMock.mockClear();
    resolversFnMock.mockClear();
  });

  // Queries
  const testQuery = gql`query { b { f }}`;
  const app = new GraphQLModule({ imports: [moduleA, moduleB.forRoot({}), moduleC] });

  it('should return the correct GraphQLSchema', async () => {
    const schema = app.schema;

    expect(schema).toBeDefined();
    expect((schema as any) instanceof GraphQLSchema).toBeTruthy();
    expect(stripWhitespaces(printSchema(schema))).toBe(stripWhitespaces(`
      type A {
        f: String
      }

      type B {
        f: String
      }

      type C {
        f: String
      }

      type Query {
        a: A
        c: C
        b: B
      }`));
  });

  it('should trigger the correct GraphQL context builders and build the correct context', async () => {
    const schema = app.schema;
    const result = await execute({
      schema,

      document: testQuery,
    });
    expect(result.errors).toBeFalsy();
    expect(result.data.b.f).toBe('1');
  });

  it('should work without a GraphQL schema and set providers', async () => {
    const provider = {};
    const token = Symbol.for('provider');
    const module = new GraphQLModule({
      providers: [{
        provide: token,
        useValue: provider,
      }],
    });
    const { injector } = new GraphQLModule({ imports: [module] });

    expect(injector.get(token)).toBe(provider);
  });

  it('should put the correct providers to the injector', async () => {

    expect(app.injector.get(ProviderA) instanceof ProviderA).toBe(true);
  });

  it('should allow to get schema', async () => {

    expect(app.schema).toBeDefined();
  });

  it('should inject dependencies to factory functions using Inject', async () => {
    const { schema } = new GraphQLModule({
      typeDefs: gql`
        type Query {
          something: String
          somethingElse: String
        }
      `,
      providers: [ProviderA, ProviderB],
      resolvers: InjectFunction(ProviderA, ProviderB)((providerA, providerB) => ({
        Query: {
          something: () => providerA.doSomething(),
          somethingElse: () => providerB.doSomethingElse(),
        },
      })),
    });
    const result = await execute({
      schema,
      document: gql`
        query {
          something
          somethingElse
        }
      `,
    });
    expect(result.errors).toBeFalsy();
    expect(result.data.something).toBe('Test1');
    expect(result.data.somethingElse).toBe('Test2');
  });

  it('should inject properties of classes', async () => {
    @Injectable()
    class FooProvider {
      message = 'FOO';
    }
    @Injectable()
    class BarProvider {
      @Inject()
      fooProvider: FooProvider;
    }
    const { injector } = new GraphQLModule({
      providers: [
        FooProvider,
        BarProvider,
      ],
    });
    expect(injector.get(BarProvider).fooProvider).toBeInstanceOf(FooProvider);
  });

  describe('Schema merging', () => {
    it('should merge types and directives correctly', async () => {
      const m1 = new GraphQLModule({
        typeDefs: [
          `directive @entity on OBJECT`,
          `directive @field on FIELD_DEFINITION`,
          `type A @entity { f: String }`,
          `type Query { a: [A!] }`,
        ],
      });
      const m2 = new GraphQLModule({
        typeDefs: [
          `directive @entity on OBJECT`,
          `directive @field on FIELD_DEFINITION`,
          `type A @entity { f: String @field }`,
          `type Query { a: [A!] }`,
        ],
      });

      const app = new GraphQLModule({
        imports: [m1, m2],
      });

      const aFields = app.schema.getTypeMap()['A']['getFields']();
      const node = aFields['f'].astNode;
      expect(node.directives.length).toBe(1);
    });
  });

  describe('Module Dependencies', () => {
    it('should init modules in the right order with onInit hook', async () => {
      let counter = 0;

      @Injectable()
      class Provider1 implements OnInit {
        count: number;

        onInit() {
          this.count = counter++;
        }
      }

      @Injectable()
      class Provider2 implements OnInit {
        count: number;

        onInit() {
          this.count = counter++;
        }
      }

      const module1 = new GraphQLModule({ imports: () => [module2], providers: [Provider1] });
      const module2 = new GraphQLModule({ providers: [Provider2] });
      const { injector } = new GraphQLModule({ imports: [module2, module1] });
      expect(injector.get(Provider1).count).toEqual(1);
      expect(injector.get(Provider2).count).toEqual(0);
      expect(counter).toEqual(2);
    });

    it('should set config per each module', async () => {

      interface IModuleConfig {
        test: number;
      }

      const module1 = new GraphQLModule({
        imports: () => [module2],
        providers: () => [Provider1],
      }).forRoot({ test: 1 });
      const module2 = new GraphQLModule({ providers: () => [Provider2] }).forRoot({ test: 2 });

      @Injectable()
      class Provider1 {
        test: number;

        constructor(@Inject(ModuleConfig(module1)) config: IModuleConfig) {
          this.test = config.test;
        }
      }

      @Injectable()
      class Provider2 {
        test: number;

        constructor(@Inject(ModuleConfig(module2)) config: IModuleConfig) {
          this.test = config.test;
        }
      }

      const { injector } = new GraphQLModule({ imports: [module2, module1] });

      expect(injector.get(Provider1).test).toEqual(1);
      expect(injector.get(Provider2).test).toEqual(2);
    });
    it('should not allow to use modules without configuration if required', async () => {
      let error;
      try {
        const { context } = new GraphQLModule({
          configRequired: true,
        });
        await context({});
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ModuleConfigRequiredError);
    });
    it('should encapsulate between providers from different non-dependent modules', async () => {
      class ProviderA {
        test = 0;
      }

      const moduleB = new GraphQLModule({ providers: [ProviderA] });

      @Injectable()
      class ProviderB {
        constructor(public providerA: ProviderA) {
        }
      }

      const moduleA = new GraphQLModule({ providers: [ProviderB] });

      try {
        const { injector } = new GraphQLModule({ imports: [moduleA, moduleB] });
        injector.get(ProviderB);
      } catch (e) {
        expect(e instanceof DependencyProviderNotFoundError).toBeTruthy();
        expect(e.dependent === ProviderB).toBeTruthy();
        expect(e.dependency === ProviderA).toBeTruthy();
      }
    });
    it('should encapsulate resolvers', async () => {

      @Injectable()
      class ProviderB {
        test = 1;
      }

      try {
        const moduleA = new GraphQLModule({
          typeDefs: gql`
            type Query {
              test: String
            }
          `,
          resolvers: InjectFunction(ProviderB)((providerB) => ({
            Query: {
              test: () => providerB.test,
            },
          })),
        });

        const moduleB = new GraphQLModule({ providers: [ProviderB] });
        const { schema } = new GraphQLModule({ imports: [moduleA, moduleB] });
        await execute({
          schema,
          document: gql`
            query {
              test
            }
          `,
        });
      } catch (e) {
        expect(e.message).toContain('ProviderB not provided in');
      }
    });
  });
  describe('onRequest Hook', () => {

    it('should call onRequest hook on each session', async () => {
      let counter = 0;
      @Injectable()
      class FooProvider implements OnRequest {
        onRequest() {
          counter++;
        }
      }

      const { schema } = new GraphQLModule({
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: () => '',
          },
        },
        providers: [
          FooProvider,
        ],
      });
      await execute({
        schema,

        document: gql`query { foo }`,
      });
      expect(counter).toBe(1);
      await execute({
        schema,

        document: gql`query { foo }`,
      });
      expect(counter).toBe(2);
      await execute({
        schema,

        document: gql`query { foo }`,
      });
      expect(counter).toBe(3);
    });

    it('should pass network session to onRequest hook', async () => {
      const fooSession = {
        foo: 'bar',
      };
      let receivedSession;

      @Injectable()
      class FooProvider implements OnRequest {
        onRequest(moduleInfo: ModuleSessionInfo) {
          receivedSession = moduleInfo.session;
        }
      }

      const { schema } = new GraphQLModule({
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: (root, args, { injector }: ModuleContext) => injector.get(ModuleSessionInfo).session.foo,
          },
        },
        providers: [
          FooProvider,
        ],
      });
      const result = await execute({
        schema,
        document: gql`query { foo }`,
        contextValue: fooSession,
      });
      expect(result.errors).toBeFalsy();
      expect(receivedSession).toBe(fooSession);
      expect(result.data.foo).toBe(fooSession.foo);
    });
  });
  describe('onResponse Hook', () => {
    
    it('should call onResponse hook on each session', async () => {
      let counter = 0;
      const fooSession = {};
      @Injectable()
      class FooProvider implements OnResponse {
        onResponse() {
          counter++;
        }
      }

      const { schema, formatResponse } = new GraphQLModule({
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: () => '',
          },
        },
        providers: [
          FooProvider,
        ],
      });
      await execute({
        schema,
        contextValue: fooSession,
        document: gql`query { foo }`,
      });
      await formatResponse({}, fooSession);
      expect(counter).toBe(1);
      await execute({
        schema,
        contextValue: fooSession,
        document: gql`query { foo }`,
      });
      await formatResponse({}, fooSession);
      expect(counter).toBe(2);
      await execute({
        schema,
        contextValue: fooSession,
        document: gql`query { foo }`,
      });
      await formatResponse({}, fooSession);
      expect(counter).toBe(3);
    });

    it('should pass network session to onResponse hook', async () => {
      const fooSession = {
        foo: 'bar',
      };
      let receivedSession;

      @Injectable()
      class FooProvider implements OnResponse {
        onResponse(moduleInfo: ModuleSessionInfo) {
          receivedSession = moduleInfo.session;
        }
      }

      const { schema, formatResponse } = new GraphQLModule({
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: (root, args, { injector }: ModuleContext) => injector.get(ModuleSessionInfo).session.foo,
          },
        },
        providers: [
          FooProvider,
        ],
      });
      const result = await execute({
        schema,
        document: gql`query { foo }`,
        contextValue: fooSession,
      });
      await formatResponse({}, fooSession);
      expect(result.errors).toBeFalsy();
      expect(receivedSession).toBe(fooSession);
      expect(result.data.foo).toBe(fooSession.foo);
    });
    it('should destroy session context after response', async () => {
      const fooSession = {
        foo: 'bar',
      };

      const myModule = new GraphQLModule({
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: (root, args, { injector }: ModuleContext) => injector.get(ModuleSessionInfo).session.foo,
          },
        },
      });
      const result = await execute({
        schema: myModule.schema,
        document: gql`query { foo }`,
        contextValue: fooSession,
      });
      await myModule.formatResponse({}, fooSession);
      expect(result.errors).toBeFalsy();
      expect(myModule['_sessionContext$Map'].has(fooSession)).toBeFalsy();
      expect(myModule.injector['_sessionSessionInjectorMap'].has(fooSession)).toBeFalsy();
    });
  });
  describe('Resolvers Composition', () => {
    it('should call resolvers composition with module context', async () => {
      const schema = app.schema;
      await execute({
        schema,

        document: testQuery,
      });
      expect(resolverCompositionCalled).toBe(true);
    });

    /* it('should call resolvers composition in correct order with correct context', async () => {
      const { schema, context } = new GraphQLModule({
        typeDefs: `
          type Query {
            foo: String
          }
        `,
        context: async () => {
          return {
            counter: 0,
            foo: null,
            bar: null,
          };
        },
        resolvers: {
          Query: {
            foo: (root, args, context, info) => {
              context.counter++;
              expect(context.foo).toBe('bar');
              expect(context.bar).toBe('foo');
              expect(context.counter).toBe(3);
              return 'Hello';
            },
          },
        },
        resolversComposition: {
          'Query.foo': [
            next => (root, args, context, info) => {
              context.counter++;
              context.foo = 'bar';
              expect(context.counter).toBe(1);
              return next(root, args, context, info);
            },
            next => (root, args, context, info) => {
              context.counter++;
              expect(context.foo).toBe('bar');
              expect(context.counter).toBe(2);
              context.bar = 'foo';
              return next(root, args, context, info);
            },
          ],
        },
      });
      const result = await execute({
        schema,
          
        document: gql`query { foo }`,
        contextValue: await context({ req: {} }),
      });
      expect(result.errors).toBeFalsy();
      expect(result.data.foo).toBe('Hello');
    });
*/
    it('should compose child resolvers with correct result and parameters', async () => {
      const getFoo = () => 'FOO';
      const FooModule = new GraphQLModule({
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: async () => getFoo(),
          },
        },
      });
      const { schema } = new GraphQLModule({
        imports: [
          FooModule,
        ],
        resolversComposition: {
          'Query.foo': next => async (root, args, context, info) => {
            const prevResult = await next(root, args, context, info);
            return getFoo() + prevResult;
          },
        },
      });
      const result = await execute({
        schema,

        document: gql`query { foo }`,
      });
      expect(result.errors).toBeFalsy();
      expect(result.data.foo).toBe('FOOFOO');
    });

    it('a resolver can be composed by two different modules', async () => {
      const FooModule = new GraphQLModule({
        name: 'foo',
        typeDefs: gql`
          type Query {
            foo: String
          }
        `,
        resolvers: {
          Query: {
            foo: async () => 'FOO',
          },
        },
      });
      const BarModule = new GraphQLModule({
        imports: [
          FooModule,
        ],
        resolversComposition: {
          'Query.foo': next => async (root, args, context, info) => {
            const prevResult = await next(root, args, context, info);
            return 'BAR' + prevResult;
          },
        },
      });
      const QuxModule = new GraphQLModule({
        imports: [
          BarModule,
        ],
        resolversComposition: {
          'Query.foo': next => async (root, args, context, info) => {
            const prevResult = await next(root, args, context, info);
            return 'QUX' + prevResult;
          },
        },
      });
      const { schema } = new GraphQLModule({
        imports: [
          QuxModule,
        ],
      });
      const result = await execute({
        schema,

        document: gql`query { foo }`,
      });
      expect(result.errors).toBeFalsy();
      expect(result.data.foo).toBe('QUXBARFOO');
    });

    it('should inject context correctly into `__resolveType`', async () => {
      let hasInjector = false;

      const { schema } = new GraphQLModule({
        typeDefs: `
          type Query {
            something: MyBase
          }

          interface MyBase {
            id: String
          }

          type MyType implements MyBase {
            id: String
          }
        `,
        resolvers: {
          Query: {
            something: () => {
              return { someValue: 1 };
            },
          },
          MyBase: {
            __resolveType: (obj, context) => {
              hasInjector = !!context.injector;

              return 'MyType';
            },
          },
          MyType: {
            id: o => o.someValue,
          },
        },
      });

      await execute({
        schema,

        document: gql`query { something { id } }`,
      });

      expect(hasInjector).toBeTruthy();
    });
  });
  describe('Schema Directives', () => {
    it('should handle schema directives', async () => {

      const typeDefs = gql`
      directive @date on FIELD_DEFINITION

      scalar Date

      type Query {
        today: Date @date
      }
      `;

      class FormattableDateDirective extends SchemaDirectiveVisitor {
        public visitFieldDefinition(field) {
          const { resolve = defaultFieldResolver } = field;

          field.args.push({
            name: 'format',
            type: GraphQLString,
          });

          field.resolve = async function (
            source,
            args,
            context,
            info,
          ) {
            const date = await resolve.call(this, source, args, context, info);
            return date.toLocaleDateString();
          };

          field.type = GraphQLString;
        }
      }

      const { schema } = new GraphQLModule({
        typeDefs,
        resolvers: {
          Query: {
            today: () => new Date(),
          },
        },
        schemaDirectives: {
          date: FormattableDateDirective,
        },
      });

      const result = await execute({
        schema,

        document: gql`query { today }`,
      });

      expect(result.data['today']).toEqual(new Date().toLocaleDateString());

    });
    it('should handle child schema directives', async () => {

      class FormattableDateDirective extends SchemaDirectiveVisitor {
        public visitFieldDefinition(field) {
          const { resolve = defaultFieldResolver } = field;

          field.args.push({
            name: 'format',
            type: GraphQLString,
          });

          field.resolve = async function (
            source,
            args,
            context,
            info,
          ) {
            const date = await resolve.call(this, source, args, context, info);
            return date.toLocaleDateString();
          };

          field.type = GraphQLString;
        }
      }

      const DateDirectiveModule = new GraphQLModule({
        typeDefs: gql`
          directive @date on FIELD_DEFINITION
        `,
        schemaDirectives: {
          date: FormattableDateDirective,
        },
      });

      const { schema } = new GraphQLModule({
        typeDefs: gql`
        scalar Date

        type Query {
          today: Date @date
        }
        `,
        resolvers: {
          Query: {
            today: () => new Date(),
          },
        },
        imports: [
          DateDirectiveModule,
        ],
      });

      const result = await execute({
        schema,

        document: gql`query { today }`,
      });

      expect(result.data['today']).toEqual(new Date().toLocaleDateString());

    });
  });
  describe('Providers Scope', () => {
    it('should construct session scope on each network session', async () => {
      let counter = 0;

      @Injectable({
        scope: ProviderScope.Session,
      })
      class ProviderA {
        constructor() {
          counter++;
        }
        test(injector: Injector) {
          return (this === injector.get(ProviderA));
        }
      }

      const { schema } = new GraphQLModule({
        typeDefs: gql`
          type Query{
            test: Boolean
          }
        `,
        resolvers: {
          Query: {
            test: (root: never, args: never, { injector }: ModuleContext) =>
              injector.get(ProviderA).test(injector),
          },
        },
        providers: [
          ProviderA,
        ],
      });
      expect(counter).toBe(0);
      const result1 = await execute({
        schema,

        document: gql`
          query {
            test
          }
        `,
      });
      expect(result1.data['test']).toBe(true);
      expect(counter).toBe(1);
      const result2 = await execute({
        schema,

        document: gql`
          query {
            test
          }
        `,
      });
      expect(result2.data['test']).toBe(true);
      expect(counter).toBe(2);
    });
    it('should construct request scope on each injector request independently from network session', async () => {
      let counter = 0;
      @Injectable({
        scope: ProviderScope.Request,
      })
      class ProviderA {
        constructor() {
          counter++;
        }
      }
      const { context, injector } = new GraphQLModule({ providers: [ProviderA] });
      expect(counter).toBe(0);
      await context({ mustBe: 0 });
      expect(counter).toBe(0);
      injector.get(ProviderA);
      expect(counter).toBe(1);
      injector.get(ProviderA);
      expect(counter).toBe(2);
    });
    it('should inject network session with moduleSessionInfo in session and request scope providers', async () => {
      const testSession = {
        foo: 'BAR',
      };
      @Injectable({
        scope: ProviderScope.Session,
      })
      class ProviderA {
        constructor(private moduleInfo: ModuleSessionInfo) { }
        test() {
          return this.moduleInfo.session.foo;
        }
      }
      @Injectable({
        scope: ProviderScope.Request,
      })
      class ProviderB {
        constructor(private moduleInfo: ModuleSessionInfo) { }
        test() {
          return this.moduleInfo.session.foo;
        }
      }
      const { schema, context } = new GraphQLModule({
        typeDefs: gql`
          type Query{
            testA: String
            testB: String
          }
        `,
        resolvers: {
          Query: {
            testA: (root: never, args: never, { injector }: ModuleContext) =>
              injector.get(ProviderA).test(),
            testB: (root: never, args: never, { injector }: ModuleContext) =>
              injector.get(ProviderB).test(),
          },
        },
        providers: [
          ProviderA,
          ProviderB,
        ],
      });
      const result = await execute({
        schema,
        document: gql`
          query {
            testA
            testB
          }
        `,
        contextValue: testSession,
      });
      expect(result.errors).toBeFalsy();
      expect(result.data['testA']).toBe('BAR');
      expect(result.data['testB']).toBe('BAR');
    });
  });
  describe('Extra Schemas', () => {
    it('should handle extraSchemas together with local ones', async () => {
      const extraSchema = makeExecutableSchema({
        typeDefs: gql`
            directive @myDirective on FIELD_DEFINITION
            type Query {
              foo: Foo
            }
            type Foo {
              id: ID
              content: String
            }
        `,
        resolvers: {
          Query: {
            foo: () => ({
              content: 'FOO',
            }),
          },
        },
      });
      const { schema, context } = new GraphQLModule({
        typeDefs: gql`
        type Query {
          bar: Bar
        }
        type Bar {
          id: ID @myDirective
          content: String
        }
      `,
        resolvers: {
          Query: {
            bar: () => ({}),
          },
          Bar: {
            content: () => 'BAR',
          },
        },
        extraSchemas: [
          extraSchema,
        ],
      });
      const contextValue = await context({ req: {} });
      const result = await execute({
        schema,

        document: gql`query { foo { content } bar { content } }`,
      });
      expect(result.errors).toBeFalsy();
      expect(result.data['foo'].content).toBe('FOO');
      expect(result.data['bar'].content).toBe('BAR');
    });
  });
  it('should mutate schema using middleware', async () => {
    const { schema, context } = new GraphQLModule({
      typeDefs: gql`
        type Query {
          foo: Boolean
        }
      `,
      resolvers: {
        Query: {
          foo: (root, args, context, info) => !!info.schema['__DIRTY__'],
        },
      },
      middleware: ({ schema }) => { schema['__DIRTY__'] = true; return { schema }; },
    });
    const result = await execute({
      schema,
      document: gql`query { foo }`,
      contextValue: await context({ req: {} }),
    });
    expect(result.errors).toBeFalsy();
    expect(result.data['foo']).toBeTruthy();
  });
  it('should avoid getting non-configured module', async () => {
    const FOO = Symbol('FOO');
    const moduleA = new GraphQLModule<{ foo: string }>({
      providers: ({ config }) => [
        {
          provide: FOO,
          useValue: config.foo,
        },
      ],
      configRequired: true,
    });
    const moduleB = new GraphQLModule({
      typeDefs: gql`
        type Query {
          foo: String
        }
      `,
      resolvers: {
        Query: {
          foo: (_, __, { injector }) => injector.get(FOO),
        },
      },
      imports: [
        moduleA,
      ],
    });
    const { schema, context } = new GraphQLModule({
      imports: [
        moduleB,
        moduleA.forRoot({
          foo: 'FOO',
        }),
      ],
    });
    const result = await execute({
      schema,
      document: gql`query { foo }`,
      contextValue: await context({ req: {} }),
    });
    expect(result.errors).toBeFalsy();
    expect(result.data['foo']).toBe('FOO');
  });
  it('should export correct typeDefs and resolvers', async () => {
    const gqlModule = new GraphQLModule({
      imports: [
        new GraphQLModule({
          name: 'test',
          typeDefs: 'type Query { test: Int }',
          resolvers: {
            Query: {
              test: () => 1,
            },
          },
        }),
      ],
    });

    const typeDefs = gqlModule.typeDefs;
    expect(stripWhitespaces(print(typeDefs))).toBe(stripWhitespaces('type Query { test: Int }'));
    const context = await gqlModule.context({});
    const resolvers = gqlModule.resolvers;
    expect(await resolvers['Query']['test'](null, {}, context, {})).toBe(1);
  });
  it('should resolve scalars correctly', async () => {
    const today = new Date();
    const { schema, context } = new GraphQLModule({
      typeDefs: gql`
        scalar Date
        type Query {
          today: Date
        }
      `,
      resolvers: {
        Date: new GraphQLScalarType({
          name: 'Date',
          description: 'Date custom scalar type',
          parseValue(value) {
            return new Date(value); // value from the client
          },
          serialize(value) {
            return value.getTime(); // value sent to the client
          },
          parseLiteral(ast) {
            if (ast.kind === Kind.INT) {
              return new Date(ast.value); // ast value is always in string format
            }
            return null;
          },
        }),
        Query: {
          today: () => today,
        },
      },
    });
    const result = await execute({
      schema,
      document: gql`query { today }`,
      contextValue: await context({ req: {} }),
    });
    expect(result.errors).toBeFalsy();
    expect(result.data['today']).toBe(today.getTime());
  });
  describe('Apollo DataSources Integration', () => {
    it('Should pass props correctly to initialize method', async () => {
      @Injectable({
        scope: ProviderScope.Session,
      })
      class TestDataSourceAPI {
        public initialize(initParams: ModuleSessionInfo) {
          expect(initParams.context['myField']).toBe('some-value');
          expect(initParams.module).toBe(moduleA);
          expect(initParams.cache).toBe(moduleA.cache);
        }
      }
      const testQuery = gql`
        query {
          a {
            f
          }
        }
      `;
      const typesA = [`type A { f: String}`, `type Query { a: A }`];
      const moduleA = new GraphQLModule({
        name: 'A',
        typeDefs: typesA,
        resolvers: {
          Query: { a: () => ({ f: 's' }) },
        },
        context: () => {
          return {
            myField: 'some-value',
          };
        },
        providers: [TestDataSourceAPI],
      });
      const app = new GraphQLModule({ imports: [moduleA] });
      await app.context({ req: {} });
    });
  });
  it('should exclude network session', async () => {
    const { schema, context } = new GraphQLModule({
      context: () => ({
        session: { foo: 'BAR' },
        // this session is not request that is internally passed by GraphQLModules
        // this session must be passed instead of Network Session
      }),
      typeDefs: gql`
        type Query {
          foo: String
        }
      `,
      resolvers: {
        Query: {
          foo: (_, __, context) => {
            return context.session.foo;
          },
        },
      },
    });
    // tslint:disable-next-line:no-console
    const result = await execute({
      schema,
      document: gql`query { foo }`,
      contextValue: await context({ req: {} }),
    });
    expect(result.errors).toBeFalsy();
    expect(result.data['foo']).toBe('BAR');
  });
  it('should import types from submodules', async () => {
    const foo = {
      name: 'FOO',
      get bar() {
        return bar;
      },
    };
    const bar = {
      name: 'BAR',
      foo,
    };
    const FooModule = new GraphQLModule({
      typeDefs: gql`
        type Foo {
          name: String
        }
      `,
    });
    const BarModule = new GraphQLModule({
      typeDefs: gql`
        extend type Foo {
          bar: Bar
        }
        type Bar {
          name: String
          foo: Foo
        }
        type Query {
          foo: Foo
          bar: Bar
        }
      `,
      imports: [FooModule],
      resolvers: {
        Query: {
          foo: () => foo,
          bar: () => bar,
        },
      },
    });
    const { schema, context } = new GraphQLModule({
      imports: [FooModule, BarModule],
    });
    const result = await execute({
      schema,
      document: gql`query { foo { name } bar { name }}`,
      contextValue: await context({ req: {} }),
    });
    expect(result.errors).toBeFalsy();
    expect(result.data['foo'].name).toBe('FOO');
    expect(result.data['bar'].name).toBe('BAR');
  });
  it('should work with SchemaLink', async () => {
    const { schema, context } = new GraphQLModule({
      typeDefs: gql`
        type Query {
          foo: String
        }
      `,
      resolvers: {
        Query: {
          foo: () => 'FOO',
        },
      },
    });
    const schemaLink = new SchemaLink({
      schema,
      context,
    });
    const apolloClient = new ApolloClient({
      link: schemaLink,
      cache: new InMemoryCache(),
    });
    const { data } = await apolloClient.query({
      query: gql`
        {
          foo
        }
      `,
    });
    expect(data.foo).toBe('FOO');
  });
});
