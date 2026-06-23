from __future__ import annotations

from app.utils import norm_text, parse_classes_text


class ProjectClassService:
    @staticmethod
    def normalize_existing(classes: list[object]) -> list[str]:
        return [str(item).strip() for item in classes if str(item).strip()]

    @staticmethod
    def validate_classes_text(classes_text: str) -> None:
        incoming = parse_classes_text(classes_text)
        if not incoming:
            raise ValueError('no class to add')

    @staticmethod
    def validate_class_name(class_name: str) -> None:
        if not norm_text(class_name):
            raise ValueError('class_name is empty')

    def merge_classes(self, existing: list[object], classes_text: str) -> list[str]:
        incoming = parse_classes_text(classes_text)
        if not incoming:
            raise ValueError('no class to add')

        normalized_existing = self.normalize_existing(existing)
        seen = {norm_text(item) for item in normalized_existing}
        merged = list(normalized_existing)
        for class_name in incoming:
            key = norm_text(class_name)
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(class_name)
        return merged

    def remove_class(self, existing: list[object], class_name: str) -> tuple[list[str], bool]:
        self.validate_class_name(class_name)
        target = norm_text(class_name)

        found = False
        kept: list[str] = []
        for item in self.normalize_existing(existing):
            if norm_text(item) == target:
                found = True
                continue
            kept.append(item)
        return kept, found
