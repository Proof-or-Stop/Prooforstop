const routes = {
  health: { status: 200, body: { ok: true } },
  invalidCreate: { status: 400, body: { error: 'name is required' } },
  validCreate: { status: 201, body: { id: 'item-1', name: 'lattice' } },
};
console.log(JSON.stringify(routes));
