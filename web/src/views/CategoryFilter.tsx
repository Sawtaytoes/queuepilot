import { useVisibility } from "@charcuterie/logic"
import { Button, Combobox } from "@charcuterie/ui"

export function CategoryFilter({
  categories,
  error,
  isLoading,
  onChange,
  value,
}: {
  categories: readonly string[]
  error: string | null
  isLoading: boolean
  onChange: (value: string) => void
  value: string
}) {
  const picker = useVisibility()
  const selectedCategories = value
    .split(",")
    .map((category) => category.trim())
    .filter(Boolean)
  const selectedLabel =
    selectedCategories.length > 0
      ? selectedCategories.join(", ")
      : "Any category"

  return (
    <Combobox
      emptyLabel="No categories available"
      error={error}
      isLoading={isLoading}
      isMultiple
      isVisible={picker.isVisible}
      onDismiss={picker.hide}
      onSelect={(category) => {
        const next = selectedCategories.includes(category)
          ? selectedCategories.filter(
              (selected) => selected !== category,
            )
          : [...selectedCategories, category]
        onChange(next.join(","))
      }}
      options={categories.map((category) => ({
        label: category,
        value: category,
      }))}
      placeholder="Any category"
      selectedValue={selectedCategories}
      trigger={
        <Button
          appearance="outline"
          aria-label={`Categories: ${selectedLabel}`}
          id="tonight-categories"
          onClick={picker.toggle}
        >
          {selectedLabel}
        </Button>
      }
    />
  )
}
