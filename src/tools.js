// Add explicitly permitted functions here; model calls never execute local code.
export class ToolRegistry {
  #tools = new Map();
  register(definition, execute) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name) || this.#tools.has(definition.name)) {
      throw new Error('Invalid or duplicate tool name');
    }
    this.#tools.set(definition.name, { definition: { ...definition, type: 'function' }, execute });
    return this;
  }
  definitions() { return [...this.#tools.values()].map(t => t.definition); }
  async execute(name, rawArguments, context) {
    const tool = this.#tools.get(name);
    if (!tool) return { error: 'Unknown tool' };
    try {
      const args = JSON.parse(rawArguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments');
      return await tool.execute(args, context);
    } catch {
      return { error: 'Tool failed or arguments were invalid' };
    }
  }
}
export function createTools() {
  return new ToolRegistry().register({
    name: 'current_time',
    description: 'Get the current time in an IANA timezone, for example Europe/Budapest.',
    parameters: {
      type: 'object', properties: { timezone: { type: 'string' } },
      required: ['timezone'], additionalProperties: false,
    },
  }, ({ timezone }) => {
    if (typeof timezone !== 'string' || timezone.length > 100) throw new Error('Invalid timezone');
    return { utc: new Date().toISOString(), local: new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, dateStyle: 'full', timeStyle: 'long',
    }).format(new Date()), timezone };
  });
}
