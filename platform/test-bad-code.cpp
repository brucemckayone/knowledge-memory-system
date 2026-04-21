// Deliberately bad C++ code for MISRA rule testing
#include <cstdint>

int*** triple_pointer = nullptr;  // 3 levels of indirection

void no_side_effects() {
    int x = 5;  // dead code, no side effects
}

int unused_return() {
    return 42;
}

void never_called() {
    int y = 10;
}

void pointer_abuse() {
    int arr1[10];
    int arr2[10];
    int* p1 = &arr1[0];
    int* p2 = &arr2[5];

    // Pointer subtraction across different arrays
    auto diff = p2 - p1;

    // Pointer comparison across different arrays
    if (p1 < p2) {
        *p1 = 0;
    }

    // Dead code after return
    return;
    int z = 99;
}

int main() {
    unused_return();  // return value ignored
    pointer_abuse();
    no_side_effects();
    // never_called() is never called
    return 0;
}
