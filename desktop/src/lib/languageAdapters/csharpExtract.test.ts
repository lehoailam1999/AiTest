import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getLanguageAdapter } from "./registry";

describe("csharp extractImports", () => {
  it("pulls constructor/interface types, not namespace folder segments", () => {
    const src = `
using Acme.Domain.Repositories.Interfaces;
using Acme.Domain.Entities;
using Moq;

namespace Acme.Application.Commands.Items;

public class ItemUpdateCommandHandler
{
    private readonly IItemRepository<Item> _repo;
    private readonly IUnitOfWork _uow;

    public ItemUpdateCommandHandler(IItemRepository<Item> repo, IUnitOfWork uow)
    {
        _repo = repo;
        _uow = uow;
    }
}
`;
    const specs = getLanguageAdapter("csharp", "x.cs").extractImports(src);
    assert.ok(specs.includes("IItemRepository"));
    assert.ok(specs.includes("IUnitOfWork"));
    assert.ok(specs.includes("Item"));
    assert.ok(!specs.includes("Interfaces"));
    assert.ok(!specs.includes("Entities"));
    assert.ok(!specs.includes("Repositories"));
  });
});
