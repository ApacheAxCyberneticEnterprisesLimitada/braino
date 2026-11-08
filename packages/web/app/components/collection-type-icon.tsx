import {
  BookA,
  BotMessageSquare,
  Bug,
  FileText,
  Landmark,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  NotebookPen,
  Package,
  Palette,
  ShieldCheck,
  Workflow,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  process: Workflow,
  "architectural-decisions": Landmark,
  "product-decisions": Package,
  "design-decisions": Palette,
  "security-decisions": ShieldCheck,
  glossary: BookA,
  "product-roadmap": MapIcon,
  "test-scenarios": ListChecks,
  bugs: Bug,
  ideas: Lightbulb,
  "agents-chats": BotMessageSquare,
  documents: NotebookPen,
};

export function CollectionTypeIcon({ template }: { template: string }) {
  const Icon = icons[template] ?? FileText;
  return <Icon aria-hidden className="h-4 w-4 shrink-0" />;
}
