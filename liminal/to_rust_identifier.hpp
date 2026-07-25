#pragma once

#include <unordered_set>
#include <string>


namespace entropy {

extern bool ContainsRustIdentifierEscapes(const std::string &identifier);
extern bool IsRustIdentifier(std::string identifier);
extern std::string ToRustIdentifier(std::string identifier);

}
