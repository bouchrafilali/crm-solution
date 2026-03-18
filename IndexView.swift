import SwiftUI

struct IndexView: View {
    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Index")
                            .font(.largeTitle.weight(.semibold))
                            .tracking(-0.4)
                        Text("Choose a module")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    LazyVGrid(columns: columns, spacing: 14) {
                        NavigationLink {
                            ModuleContainer(title: "Forecast") { ForecastView() }
                        } label: {
                            IndexCard(
                                icon: "cloud.sun.fill",
                                title: "Forecast",
                                subtitle: "Outlook",
                                tint: Color(red: 0.18, green: 0.48, blue: 0.96)
                            )
                        }

                        NavigationLink {
                            ModuleContainer(title: "Insights") { InsightsView() }
                        } label: {
                            IndexCard(
                                icon: "chart.line.uptrend.xyaxis",
                                title: "Insights",
                                subtitle: "Analytics",
                                tint: Color(red: 0.03, green: 0.58, blue: 0.56)
                            )
                        }

                        NavigationLink {
                            ModuleContainer(title: "Mobile App") { MobileAppView() }
                        } label: {
                            IndexCard(
                                icon: "iphone.gen3",
                                title: "Mobile App",
                                subtitle: "Workspace",
                                tint: Color(red: 0.10, green: 0.45, blue: 0.90)
                            )
                        }

                        NavigationLink {
                            ModuleContainer(title: "Settings") { SettingsView() }
                        } label: {
                            IndexCard(
                                icon: "gearshape.fill",
                                title: "Settings",
                                subtitle: "Preferences",
                                tint: Color(red: 0.45, green: 0.48, blue: 0.54)
                            )
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 14)
                .padding(.bottom, 28)
            }
            .background(IndexBackground().ignoresSafeArea())
            .navigationTitle("Dashboard")
            .navigationBarTitleDisplayMode(.large)
        }
    }
}

struct IndexCard: View {
    let icon: String
    let title: String
    let subtitle: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(tint.opacity(0.14))
                    .frame(width: 42, height: 42)
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .padding(.bottom, 1)

            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(.primary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(height: 136)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.regularMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(.white.opacity(0.45), lineWidth: 0.8)
                )
                .shadow(color: .black.opacity(0.06), radius: 14, x: 0, y: 8)
        )
        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct ModuleContainer<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    IOSBackButton()
                }
            }
    }
}

struct IOSBackButton: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Button { dismiss() } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.backward")
                    .font(.system(size: 13, weight: .semibold))
                Text("Back")
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(Color.blue)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(Color(.tertiarySystemFill))
            )
        }
        .buttonStyle(.plain)
    }
}

struct IndexBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(.systemGroupedBackground),
                    Color(.secondarySystemGroupedBackground)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Circle()
                .fill(Color.white.opacity(0.36))
                .frame(width: 260, height: 260)
                .blur(radius: 32)
                .offset(x: -130, y: -320)
        }
    }
}

struct ForecastView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                ForEach(1..<6) { day in
                    ModuleRow(
                        leading: "Day \(day)",
                        trailing: "\(20 + day)°",
                        symbol: day % 2 == 0 ? "cloud.sun.fill" : "sun.max.fill"
                    )
                }
            }
            .padding(18)
        }
        .background(IndexBackground().ignoresSafeArea())
    }
}

struct InsightsView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                ModuleRow(leading: "Weekly Trend", trailing: "Positive", symbol: "chart.line.uptrend.xyaxis")
                ModuleRow(leading: "Lead Quality", trailing: "Stable", symbol: "scope")
                ModuleRow(leading: "Reply Rate", trailing: "High", symbol: "message.badge.waveform")
            }
            .padding(18)
        }
        .background(IndexBackground().ignoresSafeArea())
    }
}

struct MobileAppView: View {
    @State private var notifications = true
    @State private var autoSync = false

    var body: some View {
        Form {
            Section("General") {
                Toggle("Notifications", isOn: $notifications)
                Toggle("Auto Sync", isOn: $autoSync)
            }
            Section("Version") {
                Text("1.0.0")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct SettingsView: View {
    @State private var appearance = Appearance.system
    @State private var haptics = true

    enum Appearance: String, CaseIterable, Identifiable {
        case system = "System"
        case light = "Light"
        case dark = "Dark"

        var id: String { rawValue }
    }

    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $appearance) {
                    ForEach(Appearance.allCases) { style in
                        Text(style.rawValue).tag(style)
                    }
                }
            }
            Section("Interaction") {
                Toggle("Haptics", isOn: $haptics)
            }
        }
    }
}

struct ModuleRow: View {
    let leading: String
    let trailing: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 24)

            Text(leading)
                .font(.body)
                .foregroundStyle(.primary)
            Spacer()
            Text(trailing)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.regularMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(.white.opacity(0.45), lineWidth: 0.8)
                )
        )
    }
}

#Preview {
    IndexView()
}
