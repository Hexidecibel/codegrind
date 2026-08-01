import { TOPICS, DIFFICULTIES, type Topic, type Difficulty } from '@/shared/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select';
import { humanize } from '@/client/lib/format';

export function TopicPicker({
  topic,
  difficulty,
  onTopic,
  onDifficulty,
  disabled,
}: {
  topic: Topic;
  difficulty: Difficulty;
  onTopic: (t: Topic) => void;
  onDifficulty: (d: Difficulty) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select
        value={topic}
        onValueChange={(v) => onTopic(v as Topic)}
        disabled={disabled}
      >
        <SelectTrigger className="h-11 w-[150px] lg:h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TOPICS.map((t) => (
            <SelectItem key={t} value={t}>
              {humanize(t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={difficulty}
        onValueChange={(v) => onDifficulty(v as Difficulty)}
        disabled={disabled}
      >
        <SelectTrigger className="h-11 w-[110px] capitalize lg:h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DIFFICULTIES.map((d) => (
            <SelectItem key={d} value={d} className="capitalize">
              {d}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
