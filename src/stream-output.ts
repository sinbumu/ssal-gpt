// Aggregate only finalized items. Partial argument deltas never become executable.
export class StreamOutput {
  private added = new Map<number, { id: string; type: string }>();
  private done = new Map<number, Record<string, any>>();
  private invalid = false;
  observe(event: any) {
    if (!['response.output_item.added', 'response.output_item.done'].includes(event.type)) return;
    const index = event.output_index,
      item = event.item;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 1023 ||
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 200 ||
      typeof item.type !== 'string'
    ) {
      this.invalid = true;
      return;
    }
    if (event.type === 'response.output_item.added') {
      if (this.added.has(index) || [...this.added.values()].some((v) => v.id === item.id))
        this.invalid = true;
      this.added.set(index, { id: item.id, type: item.type });
    } else {
      const prior = this.added.get(index);
      if (
        !prior ||
        prior.id !== item.id ||
        prior.type !== item.type ||
        this.done.has(index) ||
        (item.status !== undefined && item.status !== 'completed')
      )
        this.invalid = true;
      this.done.set(index, item);
    }
  }
  finish(output: unknown): {
    output?: any[];
    reconstructed?: boolean;
    invalid?: 'incomplete' | 'conflicting';
  } {
    if (this.invalid) return { invalid: 'conflicting' };
    if (!this.added.size && !this.done.size) return {};
    if (
      this.added.size !== this.done.size ||
      [...this.done.keys()].sort((a, b) => a - b).some((v, i) => v !== i)
    )
      return { invalid: 'incomplete' };
    const items = [...this.done.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (output === undefined || (Array.isArray(output) && output.length === 0))
      return { output: items, reconstructed: true };
    if (!Array.isArray(output) || output.length !== items.length) return { invalid: 'conflicting' };
    const signature = (i: any) =>
      JSON.stringify([
        i?.id,
        i?.type,
        i?.name,
        i?.namespace ?? null,
        i?.call_id,
        i?.arguments,
        i?.content,
      ]);
    if (items.some((item, i) => signature(item) !== signature(output[i])))
      return { invalid: 'conflicting' };
    return {};
  }
}
