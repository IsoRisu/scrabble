# Implementation Plan: Multi-Language Scrabble Support

Add support for Finnish, French, Spanish, and Swedish.

## User Review & Critical Decisions

> [!IMPORTANT]
> 1.  **Korean Language Support**: Korean does not have a standard Scrabble tile distribution or simple letter-value mapping like Latin-alphabet languages. I have excluded it from this implementation.
> 2.  **Language Selection**: A dropdown in the settings menu will allow players to change the language before the game starts.
> 3.  **Dictionary Management**: Word lists will be bundled in the app as text files.

-   **Decision 1**: Implement language selection via settings menu dropdown.
    -   *Why*: Simple, user-friendly.
-   **Decision 2**: Bundle language-specific dictionary and tile data files in the app.
    -   *Why*: Reliability and no external dependencies.

## 1. Overview & Core Concept

-   **What It Does**: Enhances the Scrabble game to support different languages, allowing players to select Finnish, French, Spanish, or Swedish.
-   **Key Value**: Expands the game's utility for international users.

## 2. User Experience & Visual Design

-   **Settings Menu**: Add a new dropdown in the "Edit Game Settings" panel.
-   **Game Info**: Display current language in the info panel.

## 3. Key Product Decisions & Trade-Offs

-   **Data Strategy**: Create `data/` directory for `[lang].txt` (dictionary) and update `tiles.py` for tile distribution and values.
    -   *Why*: Keeps game logic clean and data-driven.

## 4. Technical Architecture & Data Strategy

```
  app.py
  game/
    tiles.py          (Map language to TILE_DISTRIBUTION and TILE_VALUES)
    board.py
    scoring.py
    room.py           (Room state stores language, load_words(lang))
  data/
    fi.txt
    fr.txt
    es.txt
    sv.txt
```

-   **State Management**: `Room` will include `language`.
-   **Data Model**:
    -   `TILE_DISTRIBUTION_BY_LANG`: Dict mapping `lang` to its distribution.
    -   `TILE_VALUES_BY_LANG`: Dict mapping `lang` to its values.
-   **Key Sequences**:
    -   `POST /create`: Accepts optional `language`.
    -   `update_settings`: Accepts `language` change (only before first turn).
    -   `load_words(lang)`: Loads the appropriate dictionary file.
