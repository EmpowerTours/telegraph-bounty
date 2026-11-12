// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IVault} from "../src/IVault.sol";
import {VulnerableVault} from "../src/VulnerableVault.sol";
import {PatchedVault} from "../src/PatchedVault.sol";
import {Exploit as ReentrancyExploit} from "../proofs/ReentrancyExploit.sol";
import {Exploit as NoopExploit} from "../proofs/bogus/NoopExploit.sol";
import {Exploit as ForceFeedExploit} from "../proofs/bogus/ForceFeedExploit.sol";

/// Mirrors the verifier's scenario in-process so a hunter can iterate with `forge test`.
/// The verifier itself runs the same scenario on a fresh anvil chain (no cheatcodes reachable).
contract VaultsTest is Test {
    function _seed(IVault v) internal {
        address[3] memory users = [address(0xA11CE), address(0xB0B), address(0xCA401)];
        uint256[3] memory amounts = [uint256(3 ether), 3 ether, 4 ether];
        for (uint256 i; i < 3; i++) {
            vm.deal(users[i], amounts[i]);
            vm.prank(users[i]);
            v.deposit{value: amounts[i]}();
        }
    }

    function _holds(IVault v) internal view returns (bool) {
        return address(v).balance >= v.totalDeposits();
    }

    function test_reentrancyProof_breaksVulnerable() public {
        IVault v = new VulnerableVault();
        _seed(v);
        ReentrancyExploit e = new ReentrancyExploit{value: 1 ether}(address(v));
        e.run();
        assertFalse(_holds(v), "invariant should be broken on the vulnerable vault");
        assertEq(address(e).balance, 4 ether, "attacker paid 4x its deposit");
        assertEq(v.totalDeposits(), 10 ether, "books reduced only once");
        assertEq(address(v).balance, 7 ether);
    }

    function test_reentrancyProof_holdsOnPatched() public {
        IVault v = new PatchedVault();
        _seed(v);
        ReentrancyExploit e = new ReentrancyExploit{value: 1 ether}(address(v));
        vm.expectRevert(bytes("transfer failed"));
        e.run();
        assertTrue(_holds(v), "invariant must hold on the patched vault");
    }

    function test_noop_holdsOnBoth() public {
        IVault a = new VulnerableVault();
        IVault b = new PatchedVault();
        _seed(a);
        _seed(b);
        new NoopExploit{value: 1 ether}(address(a)).run();
        new NoopExploit{value: 1 ether}(address(b)).run();
        assertTrue(_holds(a));
        assertTrue(_holds(b));
    }

    /// Force-fed ether raises the balance, so it can never fake the insolvency the bounty asks for.
    function test_forceFeed_cannotFakeInsolvency() public {
        IVault a = new VulnerableVault();
        IVault b = new PatchedVault();
        _seed(a);
        _seed(b);
        ForceFeedExploit fa = new ForceFeedExploit{value: 1 ether}(address(a));
        ForceFeedExploit fb = new ForceFeedExploit{value: 1 ether}(address(b));
        fa.run();
        fb.run();
        assertTrue(_holds(a));
        assertTrue(_holds(b));
        assertGt(address(a).balance, a.totalDeposits(), "equality would have been broken");
    }

    /// Fuzz: any sequence of honest deposits then full withdrawals keeps the patched books exact.
    function testFuzz_patched_honestFlows(uint96[5] memory amounts) public {
        PatchedVault v = new PatchedVault();
        for (uint256 i; i < 5; i++) {
            uint256 amt = bound(amounts[i], 1, 1_000 ether);
            address u = address(uint160(0x1000 + i));
            vm.deal(u, amt);
            vm.prank(u);
            v.deposit{value: amt}();
            assertTrue(_holds(v));
        }
        for (uint256 i; i < 5; i++) {
            address u = address(uint160(0x1000 + i));
            vm.prank(u);
            v.withdrawAll();
            assertTrue(_holds(v));
        }
        assertEq(v.totalDeposits(), 0);
    }
}

/// Handler for the patched-vault invariant campaign: honest users plus a re-entrant attacker.
contract PatchedVaultHandler is Test {
    PatchedVault public immutable vault;
    address[4] internal users = [address(0x101), address(0x102), address(0x103), address(0x104)];

    constructor(PatchedVault v) {
        vault = v;
    }

    function deposit(uint256 who, uint256 amount) external {
        address u = users[who % users.length];
        amount = bound(amount, 1, 100 ether);
        vm.deal(u, amount);
        vm.prank(u);
        vault.deposit{value: amount}();
    }

    function withdrawAll(uint256 who) external {
        address u = users[who % users.length];
        if (vault.balances(u) == 0) return;
        vm.prank(u);
        vault.withdrawAll();
    }

    function attack(uint256 amount) external {
        amount = bound(amount, 1, 10 ether);
        vm.deal(address(this), amount);
        ReentrancyExploit e = new ReentrancyExploit{value: amount}(address(vault));
        try e.run() {} catch {}
    }
}

contract PatchedVaultInvariantTest is Test {
    PatchedVault internal vault;
    PatchedVaultHandler internal handler;

    function setUp() public {
        vault = new PatchedVault();
        handler = new PatchedVaultHandler(vault);
        vm.deal(address(handler), 0);
        targetContract(address(handler));
    }

    /// Stronger than the bounty's solvency invariant: with no force-feeding, the books are exact.
    function invariant_balanceEqualsTotalDeposits() public view {
        assertEq(address(vault).balance, vault.totalDeposits());
    }
}
