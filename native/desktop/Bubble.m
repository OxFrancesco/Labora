#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <QuartzCore/QuartzCore.h>

static EventHotKeyRef shortcut = NULL;
static EventHandlerRef handler = NULL;
static UInt32 shortcutCode = UINT32_MAX, shortcutModifiers = 0, shortcutID = 0;
static int pending = 0;
static BOOL pressed = NO;
static NSRunningApplication *previousApplication;

static OSStatus handleShortcut(EventHandlerCallRef next, EventRef event, void *context) {
    EventHotKeyID identifier;
    if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(identifier), NULL, &identifier) != noErr || identifier.signature != 'LBRA' || identifier.id != shortcutID) return eventNotHandledErr;
    if (GetEventKind(event) == kEventHotKeyPressed) {
        if (!pressed) pending++;
        pressed = YES;
    } else pressed = NO;
    return noErr;
}

int labora_shortcut_register(unsigned int code, unsigned int modifiers) {
    if (shortcut && shortcutCode == code && shortcutModifiers == modifiers) return noErr;
    if (!handler) {
        EventTypeSpec events[] = {{kEventClassKeyboard, kEventHotKeyPressed}, {kEventClassKeyboard, kEventHotKeyReleased}};
        OSStatus result = InstallEventHandler(GetApplicationEventTarget(), handleShortcut, 2, events, NULL, &handler);
        if (result != noErr) return result;
    }
    EventHotKeyRef next = NULL;
    UInt32 nextID = shortcutID + 1;
    OSStatus result = RegisterEventHotKey(code, modifiers, (EventHotKeyID){'LBRA', nextID}, GetApplicationEventTarget(), 0, &next);
    if (result != noErr) return result;
    if (shortcut) UnregisterEventHotKey(shortcut);
    shortcut = next;
    shortcutCode = code;
    shortcutModifiers = modifiers;
    shortcutID = nextID;
    pressed = NO;
    pending = 0;
    return noErr;
}

void labora_shortcut_clear(void) {
    if (shortcut) UnregisterEventHotKey(shortcut);
    shortcut = NULL;
    if (handler) RemoveEventHandler(handler);
    handler = NULL;
    pressed = NO;
    pending = 0;
}

int labora_shortcut_poll(void) {
    int result = pending;
    pending = 0;
    return result;
}

static NSWindow *bubbleWindow(void) {
    for (NSWindow *window in NSApp.windows) if ([window.title isEqualToString:@"Labora Bubble"]) return window;
    return nil;
}

int labora_bubble_prepare(void) {
    NSWindow *window = bubbleWindow();
    if (!window) return 0;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    window.titleVisibility = NSWindowTitleHidden;
    window.titlebarAppearsTransparent = YES;
    window.styleMask &= ~NSWindowStyleMaskTitled;
    window.level = NSFloatingWindowLevel;
    window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    window.hasShadow = YES;
    window.movableByWindowBackground = YES;
    [window orderOut:nil];
    return 1;
}

int labora_bubble_visible(int show, int restoreFocus) {
    NSWindow *window = bubbleWindow();
    if (!window) return 0;
    if (!show) {
        [window orderOut:nil];
        if (restoreFocus && previousApplication && !previousApplication.terminated) [previousApplication activateWithOptions:0];
        previousApplication = nil;
        return 1;
    }
    previousApplication = NSWorkspace.sharedWorkspace.frontmostApplication;
    NSScreen *screen = NSScreen.mainScreen;
    for (NSScreen *candidate in NSScreen.screens) if (NSMouseInRect(NSEvent.mouseLocation, candidate.frame, NO)) screen = candidate;
    NSRect available = screen.visibleFrame;
    NSRect frame = window.frame;
    frame.size.width = MIN(frame.size.width, available.size.width - 32);
    frame.size.height = MIN(frame.size.height, available.size.height - 32);
    frame.origin = NSMakePoint(NSMaxX(available) - frame.size.width - 16, NSMinY(available) + 16);
    BOOL animate = !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    NSRect start = frame;
    if (animate) start.origin.y -= 6;
    [window setFrame:start display:YES];
    window.alphaValue = animate ? 0 : 1;
    [NSApp activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
    if (animate) [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.14;
        context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
        [[window animator] setFrame:frame display:YES];
        [[window animator] setAlphaValue:1];
    } completionHandler:nil];
    return 1;
}

void labora_character_window_prepare(void) {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    for (NSWindow *window in NSApp.windows) {
        if (![window.title isEqualToString:@"Labora Characters"]) continue;
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
    }
}
