// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LendPool as LendPoolVuln} from "../lend-pool/LendPool.sol";
import {LendPool as LendPoolFixed} from "../lend-pool/LendPoolPatched.sol";
import {HookVault as HookVaultVuln} from "../hook-vault/HookVault.sol";
import {HookVault as HookVaultFixed} from "../hook-vault/HookVaultPatched.sol";
import {Exploit as LendExploit} from "../_reference/LendPoolExploit.sol";
import {Exploit as HookExploit} from "../_reference/HookVaultExploit.sol";

interface IPool {
    function addLiquidity(uint256 amount) external payable;
    function supply() external payable;
    function buyGov() external payable;
    function sellGov(uint256 amount) external;
    function govOf(address) external view returns (uint256);
    function depositCollateral(uint256 amount) external;
    function withdrawCollateral(uint256 amount) external;
    function borrow(uint256 amount) external;
    function repay() external payable;
    function maxBorrow(address) external view returns (uint256);
    function totalCollateral() external view returns (uint256);
    function totalDebt() external view returns (uint256);
}

interface IToken {
    function wrap() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IHook {
    function token() external view returns (IToken);
    function deposit(uint256) external;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
}

/// Mirrors targets/lend-pool/target.js and targets/hook-vault/target.js in-process. The verifier
/// itself runs the scenarios on fresh anvil chains (no cheatcodes reachable from a proof).
contract HardTargetsTest is Test {
    address constant ATTACKER = address(0xA77);
    address[3] users = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint256[3] seeds = [uint256(3 ether), 3 ether, 4 ether];
    uint256 constant FAIR_PRICE = 0.001 ether; // 10 ETH / 10,000 GOV

    // ---------- lend-pool ----------
    function _lendSetup(address p) internal {
        IPool(p).addLiquidity{value: 10 ether}(10_000 ether);
        for (uint256 i; i < 3; i++) {
            vm.deal(users[i], seeds[i]);
            vm.prank(users[i]);
            IPool(p).supply{value: seeds[i]}();
        }
    }

    function _lendHolds(address p) internal view returns (bool) {
        return IPool(p).totalCollateral() * FAIR_PRICE / 1e18 >= IPool(p).totalDebt();
    }

    function _lendAttack(address p) internal {
        vm.deal(ATTACKER, 10 ether);
        vm.startPrank(ATTACKER);
        LendExploit e = new LendExploit{value: 10 ether}(p);
        e.run();
        vm.stopPrank();
    }

    function test_lendPool_referenceBreaksVulnerable() public {
        LendPoolVuln p = new LendPoolVuln();
        _lendSetup(address(p));
        _lendAttack(address(p));
        assertFalse(_lendHolds(address(p)));
        assertEq(p.totalDebt(), 10 ether); // every lent ether borrowed
    }

    function test_lendPool_referenceFailsOnPatched() public {
        LendPoolFixed p = new LendPoolFixed();
        _lendSetup(address(p));
        _lendAttack(address(p));
        assertTrue(_lendHolds(address(p)));
        assertLe(p.totalDebt(), p.totalCollateral() * FAIR_PRICE / 1e18 * 3 / 4 + 1);
    }

    /// Honest borrower at fair price, then repay and withdraw collateral: holds on both versions.
    function test_lendPool_honestBorrowHoldsOnBoth() public {
        address[2] memory pools = [address(new LendPoolVuln()), address(new LendPoolFixed())];
        for (uint256 k; k < 2; k++) {
            address p = pools[k];
            _lendSetup(p);
            vm.deal(ATTACKER, 2 ether);
            vm.startPrank(ATTACKER);
            IPool(p).buyGov{value: 1 ether}();
            uint256 g = IPool(p).govOf(ATTACKER);
            IPool(p).depositCollateral(g);
            IPool(p).borrow(IPool(p).maxBorrow(ATTACKER));
            assertTrue(_lendHolds(p));
            IPool(p).repay{value: IPool(p).totalDebt()}();
            IPool(p).withdrawCollateral(g);
            IPool(p).sellGov(g);
            vm.stopPrank();
            assertTrue(_lendHolds(p));
        }
    }

    /// Fuzz: whatever share of 10 ether the attacker spends moving the price first, borrowing
    /// on the patched pool never leaves debt unbacked at the fair price.
    function testFuzz_lendPool_patchedResistsPriceMoves(uint256 pump, uint256 post) public {
        LendPoolFixed p = new LendPoolFixed();
        _lendSetup(address(p));
        pump = bound(pump, 0.01 ether, 10 ether);
        vm.deal(ATTACKER, pump);
        vm.startPrank(ATTACKER);
        p.buyGov{value: pump}();
        post = bound(post, 1, p.govOf(ATTACKER));
        p.depositCollateral(post);
        uint256 m = p.maxBorrow(ATTACKER);
        if (m > 10 ether) m = 10 ether;
        if (m > 0) p.borrow(m);
        vm.stopPrank();
        assertTrue(_lendHolds(address(p)));
    }

    // ---------- hook-vault ----------
    function _hookSetup(address v) internal {
        IToken t = IHook(v).token();
        for (uint256 i; i < 3; i++) {
            vm.deal(users[i], seeds[i]);
            vm.startPrank(users[i]);
            t.wrap{value: seeds[i]}();
            t.approve(v, seeds[i]);
            IHook(v).deposit(seeds[i]);
            vm.stopPrank();
        }
    }

    /// Honest users withdraw everything; true iff each ends with at least their deposit.
    function _hookHolds(address v) internal returns (bool ok) {
        IToken t = IHook(v).token();
        ok = true;
        for (uint256 i; i < 3; i++) {
            uint256 b = IHook(v).balanceOf(users[i]);
            if (b > 0) {
                vm.prank(users[i]);
                try IHook(v).withdraw(b) {} catch {}
            }
            if (t.balanceOf(users[i]) < seeds[i]) ok = false;
        }
    }

    function test_hookVault_honestFlowHoldsOnBoth() public {
        HookVaultVuln a = new HookVaultVuln();
        _hookSetup(address(a));
        assertTrue(_hookHolds(address(a)));
        HookVaultFixed b = new HookVaultFixed();
        _hookSetup(address(b));
        assertTrue(_hookHolds(address(b)));
    }

    function test_hookVault_referenceBreaksVulnerable() public {
        HookVaultVuln v = new HookVaultVuln();
        _hookSetup(address(v));
        vm.deal(ATTACKER, 1 ether);
        vm.prank(ATTACKER);
        HookExploit e = new HookExploit{value: 1 ether}(address(v));
        vm.prank(ATTACKER);
        e.run();
        assertEq(v.token().balanceOf(address(v)), 0);
        assertFalse(_hookHolds(address(v)));
    }

    function test_hookVault_referenceFailsOnPatched() public {
        HookVaultFixed v = new HookVaultFixed();
        _hookSetup(address(v));
        vm.deal(ATTACKER, 1 ether);
        vm.prank(ATTACKER);
        HookExploit e = new HookExploit{value: 1 ether}(address(v));
        vm.prank(ATTACKER);
        e.run();
        assertEq(v.balanceOf(address(e.sink())), 0);
        assertEq(v.token().balanceOf(address(v)), 10 ether);
        assertTrue(_hookHolds(address(v)));
    }

    receive() external payable {}
}
