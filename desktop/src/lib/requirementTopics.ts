export type RequirementTopicItem = {
  id: string;
  title: string;
  notes?: string;
};

export type RequirementTopic = {
  id: string;
  title: string;
  notes?: string;
  items: RequirementTopicItem[];
};

export function newTopicId(): string {
  return crypto.randomUUID();
}

export function emptyTopic(title = ""): RequirementTopic {
  return { id: newTopicId(), title, notes: "", items: [] };
}

export function emptyTopicItem(title = ""): RequirementTopicItem {
  return { id: newTopicId(), title, notes: "" };
}
